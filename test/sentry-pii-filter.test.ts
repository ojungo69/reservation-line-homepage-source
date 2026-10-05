/**
 * D1: PII filter unit tests — exercises every redaction pattern in
 * src/sentry-pii-filter.ts to ensure no raw PII leaks to Sentry.
 */
import { describe, expect, it } from "vitest";
import { requestDataIntegration, winterCGRequestToRequestData } from "@sentry/core";

import {
  scrubSentryEvent,
  scrubSentryBreadcrumb,
  _deepScrubForTest as deepScrub,
  _redactStringExtendedForTest as redactStringExtended
} from "../src/sentry-pii-filter";
import type { ErrorEvent, Breadcrumb } from "@sentry/cloudflare";

describe("LINE authentication material", () => {
  it.each(["X-LINE-Signature", "X-Goog-Channel-Token", "CF-Access-Client-Secret"])("scrubs the %s authentication header", (header) => {
    const result = scrubSentryEvent({ type: undefined, request: { headers: { [header]: "syntheticWebhookSecret" } } });
    expect(result?.request?.headers?.[header]).toBe("[REDACTED]");
  });
  it("scrubs aliases in request headers, body, contexts and breadcrumbs while retaining diagnostics", () => {
    const secret = "opaque+/token==";
    const result = scrubSentryEvent({
      type: undefined,
      request: {
        headers: { "X-LINE-IdToken": secret, "x_line_access_token": secret, "X-LINE-Nonce": secret, "content-type": "application/json" },
        data: { idToken: secret, lineAccessToken: secret, turnstileToken: secret }
      },
      extra: { nonce: secret, hasIdToken: true },
      contexts: { auth: { id_token: secret, safe: "failure" } }
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result?.request?.headers?.["content-type"]).toBe("application/json");
    expect(result?.extra?.hasIdToken).toBe(true);
    expect(scrubSentryBreadcrumb({ data: { lineAccessToken: secret, status: 401 } })?.data)
      .toEqual({ lineAccessToken: "[REDACTED]", status: 401 });
  });

  it("removes actual SDK-captured LINE headers before the error event is sent", () => {
    const token = "syntheticOpaque+/token==";
    const event: ErrorEvent = {
      type: undefined,
      sdkProcessingMetadata: {
        normalizedRequest: winterCGRequestToRequestData(new Request("https://example.test/api/public/my-reservations", {
          headers: { "X-LINE-IdToken": token, "X-LINE-AccessToken": token, "cf-ray": "safe-ray" }
        }))
      }
    };
    requestDataIntegration({ include: { data: false, cookies: false } }).processEvent!(event, {}, {
      getDataCollectionOptions: () => ({ cookies: false, httpHeaders: { request: true }, userInfo: false, urlQueryParams: true })
    } as never);
    expect(event.request?.headers?.["x-line-accesstoken"]).toBe(token);
    const result = scrubSentryEvent(event);
    expect(JSON.stringify(result?.request)).not.toContain("syntheticOpaque");
    expect(result?.request?.headers?.["cf-ray"]).toBe("safe-ray");
  });

  it.each([
    'id%54oken=opaque%2B%2Ftoken%3D%3D&idToken=opaqueAgain&safe=booking',
    { id_token: "opaque+/token==", safe: "booking" },
    [["lineAccessToken", "opaque+/token=="], ["safe", "booking"]]
  ])("scrubs separate query representations and preserves safe parameters", (query) => {
    const result = scrubSentryEvent({ request: { query_string: query } } as ErrorEvent);
    const text = JSON.stringify(result);
    expect(text).not.toContain("opaque");
    expect(text).toContain("booking");
  });

  it("scrubs credential aliases in diagnostic JSON, URLs and opaque Bearer values", () => {
    const secret = "opaque+/token==";
    const result = scrubSentryBreadcrumb({
      message: `Bearer ${secret}`,
      data: {
        body: JSON.stringify({ idToken: secret, lineAccessToken: secret, nonce: secret, safe: "booking" }),
        url: `https://example.test/?id_token=${secret}&safe=booking`
      }
    });
    expect(JSON.stringify(result)).not.toContain("opaque");
    expect(JSON.stringify(result)).toContain("booking");
  });

  it("scrubs encoded authentication keys in diagnostic strings", () => {
    const result = scrubSentryBreadcrumb({ message: '{"\\u0069dToken":"opaqueEncodedSecret"} https://example.test/?id%54oken=opaqueEncodedSecret&safe=booking' });
    expect(result?.message).not.toContain("opaqueEncodedSecret");
    expect(result?.message).toContain("booking");
  });

  it("scrubs composite and malformed diagnostic credentials at error and breadcrumb boundaries", () => {
    const message = 'failure [{"\\U0069dToken":{"value":"opaqueSecret"}}] https://example.test/?access%ZZ_token=opaque?Secret&safe=booking';
    const results = [scrubSentryEvent({ type: undefined, message }), scrubSentryBreadcrumb({ message })];
    for (const result of results) {
      expect(result?.message).not.toContain("opaque");
      expect(result?.message).not.toContain("Secret");
      expect(result?.message).toContain("booking");
    }
  });

  it("drops an ambiguous secret suffix at both error and breadcrumb boundaries", () => {
    const message = 'safe=booking {"idToken":"opaqueSecret" \nsyntheticSecretTail}';
    for (const result of [scrubSentryEvent({ type: undefined, message }), scrubSentryBreadcrumb({ message })]) {
      expect(result?.message).toBe('safe=booking {"[REDACTED]":"[REDACTED]"');
    }
  });
});

// ── LINE userId ──────────────────────────────────────────────────────

describe("LINE userId redaction", () => {
  it("redacts a standard LINE userId (uppercase U + 32 lowercase hex)", () => {
    const input = "user Ua1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4 did something";
    expect(redactStringExtended(input)).toBe(
      "user [REDACTED_LINE_USER_ID] did something"
    );
  });

  it("redacts LINE userId with mixed-case hex digits", () => {
    const input = "Ua1B2c3D4e5F6a1B2c3D4e5F6a1B2c3D4";
    expect(redactStringExtended(input)).toBe("[REDACTED_LINE_USER_ID]");
  });

  it("does not redact strings that look like userId but wrong length", () => {
    const input = "Ua1b2c3d4"; // too short
    expect(redactStringExtended(input)).toBe("Ua1b2c3d4");
  });
});

// ── Phone numbers ────────────────────────────────────────────────────

describe("phone number redaction", () => {
  it("redacts Kyoto landline 075-123-4567", () => {
    const result = redactStringExtended("call 075-123-4567 now");
    expect(result).not.toContain("075");
    expect(result).toContain("[REDACTED_PHONE]");
  });

  it.each([
    {
      caseName: "Kyoto landline without dashes 0751234567",
      input: "phone: 0751234567",
      notContain: ["0751234567"]
    },
    {
      caseName: "Kyoto landline with space separator 075 123 4567",
      input: "tel 075 123 4567 end",
      notContain: ["0751234567"]
    },
    {
      caseName: "Tokyo landline 03-1234-5678",
      input: "office 03-1234-5678",
      notContain: ["03"]
    },
    {
      caseName: "mobile 090-1234-5678",
      input: "mobile: 090-1234-5678",
      notContain: ["090"]
    }
  ])("redacts $caseName", ({ input, notContain }) => {
    const result = redactStringExtended(input);
    expect(result).toContain("[REDACTED_PHONE]");
    for (const value of notContain) {
      expect(result).not.toContain(value);
    }
  });

  it("redacts full-width digit phone (NFKC normalization)", () => {
    // ０９０１２３４５６７８ (full-width digits)
    const fullWidth = "０９０１２３４５６７８";
    const result = redactStringExtended(`phone: ${fullWidth}`);
    expect(result).toContain("[REDACTED_PHONE]");
  });

  it("redacts phone with non-ASCII dashes (em-dash)", () => {
    // 075—123—4567 with em-dash U+2014
    const input = "phone: 075—123—4567";
    const result = redactStringExtended(input);
    expect(result).toContain("[REDACTED_PHONE]");
  });

  it("redacts phone with katakana prolonged sound mark as dash", () => {
    // 075ー123ー4567 with U+30FC
    const input = "075ー123ー4567";
    const result = redactStringExtended(input);
    expect(result).toContain("[REDACTED_PHONE]");
  });

  it("does not false-positive on 8-digit non-phone numbers", () => {
    // 8-digit number not starting with 0 should not be redacted as phone
    const input = "order 12345678 confirmed";
    expect(redactStringExtended(input)).toBe("order 12345678 confirmed");
  });
});

// ── Email ────────────────────────────────────────────────────────────

describe("email redaction", () => {
  it("redacts standard email", () => {
    const result = redactStringExtended("contact foo@example.co.jp for info");
    expect(result).toContain("[REDACTED_EMAIL]");
    expect(result).not.toContain("foo@example");
  });

  it("redacts tagged email", () => {
    const result = redactStringExtended("bar+tag@sub.example.com");
    expect(result).toBe("[REDACTED_EMAIL]");
  });
});

// ── SENSITIVE_KEY_PATTERN_EXTENDED ───────────────────────────────────

describe("sensitive key redaction via deepScrub", () => {
  const sensitiveKeys = [
    "line_user_id",
    "line_identity_id",
    "display_name",
    "display_name_kana",
    "customer_display_name",
    "customer_name",
    "customer_phone",
    "customer_email",
    "phone",
    "phone_normalized",
    "phone_hash",
    "email",
    "address",
    "location",
    "payload_json",
    "access_token",
    "refresh_token",
    "private_key",
    "client_secret",
    "consent_signature_hash",
    "provider_message_id",
    "recipient_user_id",
    "recipient_id",
    "recipientLineUserId"
  ];

  for (const key of sensitiveKeys) {
    it(`redacts value under key "${key}"`, () => {
      const result = deepScrub({ [key]: "sensitive-value" });
      expect(result).toEqual({ [key]: "[REDACTED]" });
    });
  }

  it("is case-insensitive for key matching", () => {
    expect(deepScrub({ LINE_USER_ID: "test" })).toEqual({
      LINE_USER_ID: "[REDACTED]"
    });
  });
});

// ── Nested object/array recursion ────────────────────────────────────

describe("deep recursion", () => {
  it("scrubs PII in nested objects", () => {
    const input = {
      outer: {
        display_name: "secret name",
        safe: "hello"
      }
    };
    const result = deepScrub(input) as Record<string, unknown>;
    expect((result.outer as Record<string, unknown>).display_name).toBe("[REDACTED]");
    expect((result.outer as Record<string, unknown>).safe).toBe("hello");
  });

  it("scrubs PII in arrays", () => {
    const input = ["Ua1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4", "safe string"];
    const result = deepScrub(input) as string[];
    expect(result[0]).toBe("[REDACTED_LINE_USER_ID]");
    expect(result[1]).toBe("safe string");
  });

  it("handles deeply nested mixed structures", () => {
    const input = {
      level1: {
        items: [
          { email: "test@example.com", id: 42 },
          "phone 090-1234-5678"
        ]
      }
    };
    const result = deepScrub(input) as Record<string, unknown>;
    const level1 = result.level1 as Record<string, unknown>;
    const items = level1.items as unknown[];
    expect((items[0] as Record<string, unknown>).email).toBe("[REDACTED]");
    expect((items[0] as Record<string, unknown>).id).toBe(42);
    expect(items[1]).toContain("[REDACTED_PHONE]");
  });

  it("passes through non-string non-object primitives", () => {
    expect(deepScrub(42)).toBe(42);
    expect(deepScrub(true)).toBe(true);
    expect(deepScrub(null)).toBeNull();
    expect(deepScrub(undefined)).toBeUndefined();
  });
});

// ── scrubSentryEvent ─────────────────────────────────────────────────

describe("scrubSentryEvent", () => {
  it("scrubs PII from event.message", () => {
    const event = {
      type: undefined,
      message: "Error for user Ua1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"
    };
    const result = scrubSentryEvent(event);
    expect(result?.message).toContain("[REDACTED_LINE_USER_ID]");
  });

  it("scrubs PII from exception values", () => {
    const event = {
      type: undefined,
      exception: {
        values: [
          { type: "Error", value: "phone 075-123-4567 invalid" }
        ]
      }
    };
    const result = scrubSentryEvent(event);
    expect(result?.exception?.values?.[0]?.value).toContain("[REDACTED_PHONE]");
    expect(result?.exception?.values?.[0]?.value).not.toContain("075");
  });

  it("scrubs PII from event.extra", () => {
    const event = {
      type: undefined,
      extra: {
        line_user_id: "Ua1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
        debug: "safe"
      }
    };
    const result = scrubSentryEvent(event);
    expect(result?.extra?.line_user_id).toBe("[REDACTED]");
    expect(result?.extra?.debug).toBe("safe");
  });

  it("scrubs PII from event.contexts", () => {
    const event = {
      type: undefined,
      contexts: {
        reservation: {
          display_name: "Secret Name",
          id: "res_123"
        }
      }
    };
    const result = scrubSentryEvent(event);
    const ctx = result?.contexts?.reservation as Record<string, unknown>;
    expect(ctx.display_name).toBe("[REDACTED]");
    expect(ctx.id).toBe("res_123");
  });

  it("scrubs PII from request URL", () => {
    const event = {
      type: undefined,
      request: {
        url: "https://example.com?email=foo@example.com"
      }
    };
    const result = scrubSentryEvent(event);
    expect(new URL(result!.request!.url!).searchParams.get("email")).toBe("[REDACTED]");
    expect(result?.request?.url).not.toContain("foo");
  });

  it.each(["store%40gmail.com", "store%40gmail.com%ZZ"])("scrubs an encoded account path %s from errors", (segment) => {
    const result = scrubSentryEvent({ type: undefined, request: { url: `https://example.test/calendars/${segment}/events` } });
    expect(result?.request?.url).not.toContain("gmail.com");
    expect(decodeURIComponent(result!.request!.url!)).toContain("[REDACTED");
  });

  it("scrubs PII from request headers", () => {
    const event = {
      type: undefined,
      request: {
        headers: {
          authorization: "Bearer secret_token_here"
        }
      }
    };
    const result = scrubSentryEvent(event);
    expect(result?.request?.headers?.authorization).toBe("[REDACTED]");
  });

  it("scrubs PII from request body data (object form)", () => {
    const event = {
      type: undefined,
      request: {
        data: {
          customerName: "山田太郎",
          phone: "09012345678",
          email: "foo@example.com"
        }
      }
    };
    const result = scrubSentryEvent(event);
    const serialized = JSON.stringify(result?.request?.data);
    // Object bodies are redacted by sensitive key (phone/email/name) → [REDACTED].
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("09012345678");
    expect(serialized).not.toContain("foo@example.com");
    expect(serialized).not.toContain("山田太郎");
  });

  it("scrubs PII from request body data (string form)", () => {
    const event = {
      type: undefined,
      request: { data: "email=foo@example.com tel 09012345678" }
    };
    const result = scrubSentryEvent(event);
    expect(String(result?.request?.data)).toContain("[REDACTED_EMAIL]");
    expect(String(result?.request?.data)).not.toContain("foo@example.com");
  });

  it("returns event (not null) for valid events", () => {
    const event = {
      type: undefined, message: "test" };
    expect(scrubSentryEvent(event)).not.toBeNull();
  });
});

// ── scrubSentryBreadcrumb ────────────────────────────────────────────

describe("scrubSentryBreadcrumb", () => {
  it("scrubs the encoded Calendar account URL collected by the default Fetch integration", () => {
    const result = scrubSentryBreadcrumb({
      category: "fetch", type: "http",
      data: {
        method: "GET", status_code: 200,
        url: "https://www.googleapis.com/calendar/v3/calendars/store%40gmail.com/events?syncToken=syntheticSecret&maxResults=250"
      }
    });
    expect(JSON.stringify(result)).not.toContain("gmail.com");
    expect(JSON.stringify(result)).not.toContain("syntheticSecret");
    expect(decodeURIComponent(result!.data!.url as string)).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/[REDACTED_EMAIL]/events?syncToken=[REDACTED]&maxResults=250"
    );
    expect(result?.data?.method).toBe("GET");
    expect(result?.data?.status_code).toBe(200);
  });

  it("scrubs PII from breadcrumb message", () => {
    const bc: Breadcrumb = {
      message: "User Ua1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4 clicked"
    };
    const result = scrubSentryBreadcrumb(bc);
    expect(result?.message).toContain("[REDACTED_LINE_USER_ID]");
  });

  it("scrubs PII from breadcrumb data", () => {
    const bc: Breadcrumb = {
      message: "action",
      data: {
        phone: "090-1234-5678",
        action: "submit"
      }
    };
    const result = scrubSentryBreadcrumb(bc);
    expect(result?.data?.phone).toBe("[REDACTED]");
    expect(result?.data?.action).toBe("submit");
  });
});

// ── Security regression tests (iter 1 fixes) ─────────────────────────

describe("redactStringExtended — secret / +81 / cookie regression (iter 1 fixes)", () => {
  it("redacts +81 mobile (+81 90 1234 5678)", () => {
    const result = redactStringExtended("error: phone +81 90 1234 5678 invalid");
    expect(result).toContain("[REDACTED_PHONE]");
    expect(result).not.toContain("8190");
    expect(result).not.toContain("12345678");
  });

  it("redacts +81 hyphen landline (+81-75-123-4567)", () => {
    const result = redactStringExtended("contact +81-75-123-4567");
    expect(result).toContain("[REDACTED_PHONE]");
    expect(result).not.toContain("75-123-4567");
  });

  it("redacts +81 compact (+819012345678)", () => {
    const result = redactStringExtended("call +819012345678 now");
    expect(result).toContain("[REDACTED_PHONE]");
    expect(result).not.toContain("819012345678");
  });

  it("redacts Bearer tokens via sanitizeValue delegation", () => {
    const fakeToken = "FAKE.JWT.PLACEHOLDER-NOT-A-REAL-TOKEN";
    const result = redactStringExtended(`Authorization: Bearer ${fakeToken}`);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain(fakeToken);
  });

  // Use a placeholder body that does not match real key heuristics, and
  // assemble the PEM armor / token fixtures at runtime, so GitGuardian and
  // Semgrep secret scanners don't flag this fixture in source. The redactor
  // receives the exact same strings — it matches structure, not key validity.
  const fakePemBody = "FAKE-PEM-PLACEHOLDER-NOT-A-REAL-KEY-FOR-REDACTION-TEST";
  const pemArmor = (kind: "BEGIN" | "END") => ["-----" + kind, "RSA", "PRIVATE", "KEY-----"].join(" ");
  const fakeSyncToken = ["CPDAlvWDx7QC", "EPDAlvWDx"].join("");

  it.each([
    {
      caseName: "?access_token= query param",
      input: "https://api.example.com/v1?access_token=abc123def456&foo=bar",
      notContain: "abc123def456"
    },
    {
      caseName: "?syncToken= query param",
      input: `https://api.example.com/calendar?syncToken=${fakeSyncToken}`,
      notContain: fakeSyncToken
    },
    {
      caseName: "?channelToken= query param",
      input: "watch url ?channelToken=channel-secret-1234567890",
      notContain: "channel-secret-1234567890"
    },
    {
      caseName: "PEM private key blocks",
      input: `prefix ${pemArmor("BEGIN")}\n${fakePemBody}\n${pemArmor("END")} suffix`,
      notContain: fakePemBody
    }
  ])("redacts $caseName", ({ input, notContain }) => {
    const result = redactStringExtended(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain(notContain);
  });

  it("redacts inline JSON secret values", () => {
    const result = redactStringExtended('{"access_token":"AKIAEXAMPLE12345","other":"safe"}');
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("AKIAEXAMPLE12345");
  });
});

describe("scrubSentryEvent — request.headers cookie/auth regression (iter 1 fixes)", () => {
  it("redacts request.headers.cookie", () => {
    const event = {
      type: undefined,
      request: {
        headers: {
          cookie: "session=abc123def456; user=jane"
        }
      }
    };
    const result = scrubSentryEvent(event as never);
    expect((result?.request?.headers as Record<string, string>)?.cookie).toBe("[REDACTED]");
  });

  it("redacts request.headers.set-cookie", () => {
    const event = {
      type: undefined,
      request: {
        headers: {
          "set-cookie": "session=xyz789; HttpOnly"
        }
      }
    };
    const result = scrubSentryEvent(event as never);
    expect((result?.request?.headers as Record<string, string>)?.["set-cookie"]).toBe("[REDACTED]");
  });

  it("redacts request.headers.cf-access-jwt-assertion", () => {
    const event = {
      type: undefined,
      request: {
        headers: {
          "cf-access-jwt-assertion": "FAKE.JWT.PLACEHOLDER-NOT-A-REAL-TOKEN"
        }
      }
    };
    const result = scrubSentryEvent(event as never);
    expect(
      (result?.request?.headers as Record<string, string>)?.["cf-access-jwt-assertion"]
    ).toBe("[REDACTED]");
  });
});

// ── calendar_id in Sentry deepScrub (no special bypass) ──────────────
//
// Sentry deepScrub deliberately does NOT honor SERVICE_IDENTIFIER_KEY_PATTERN
// because the captured-context shape is untyped — a nested `calendar_id` key
// holding a customer email would otherwise leak. Google service-domain
// calendar IDs still flow through because EMAIL_PATTERN's exempt domains
// match them; Gmail-shaped primary calendar IDs get redacted to
// [REDACTED_EMAIL] in Sentry events. The typed src/logging.ts flow retains
// the Gmail passthrough — see test/logging.test.ts.
describe("calendar_id under Sentry deepScrub", () => {
  it("preserves Google service-domain calendar IDs via EMAIL_PATTERN exempt list", () => {
    const result = deepScrub("abc123-uuid@group.calendar.google.com", "calendar_id");
    expect(result).toBe("abc123-uuid@group.calendar.google.com");
  });

  it("redacts Gmail-shaped primary calendar IDs to label (no key-based bypass)", () => {
    const result = deepScrub("store.tokyo@gmail.com", "calendar_id");
    expect(result).toBe("[REDACTED_EMAIL]");
  });

  it("redacts Bearer / phone noise inside calendar_id value", () => {
    const result = deepScrub(
      "Bearer eyFake token and phone 0901234567 mixed in",
      "calendar_id"
    );
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("eyFake");
    expect(result).not.toContain("0901234567");
  });

  it("redacts a customer email put under a nested calendar_id key (PoC fix)", () => {
    // Adversarial scenario: misuse-aware operator places a customer email
    // inside contexts.foo.calendar_id. The Sentry path must redact it.
    const result = deepScrub(
      { nested: { calendar_id: "victim.customer@gmail.com" } },
      "extra"
    ) as { nested: { calendar_id: string } };
    expect(result.nested.calendar_id).toBe("[REDACTED_EMAIL]");
  });
});

// ── ReDoS guard via REDACTOR_INPUT_MAX_LEN ───────────────────────────

describe("ReDoS guard in shared helpers", () => {
  it("redacts long strings within linear-bounded CPU budget", () => {
    const long = "a@" + ".".repeat(50_000) + "1 and 0901234567 trailing";
    const start = Date.now();
    const result = redactStringExtended(long);
    const elapsed = Date.now() - start;
    // Phase 1 slice/recurse bounds regex CPU to first 4096 chars per shared
    // helper. Phase 2 sanitizeValue then truncates the result to 256 chars
    // (downstream MAX_STRING_LENGTH contract). We assert the helper itself
    // doesn't blow up CPU on long pathological input.
    expect(result.length).toBeLessThan(400);
    // Generous wall-clock bound: an exponential regex on 50k chars takes seconds,
    // while parallel-suite scheduling jitter has pushed a linear run past 100ms
    // (observed 106ms/265ms). 500ms still fails on any real ReDoS regression.
    expect(elapsed).toBeLessThan(500);
  });

  it("redacts phone inside the head slice when input exceeds the cap", () => {
    const long = "called 0901234567 back " + "x".repeat(50_000);
    const result = redactStringExtended(long);
    // The phone appears in the first 4096 chars, so it must be redacted.
    expect(result).toContain("[REDACTED_PHONE]");
    expect(result).not.toContain("0901234567");
  });
});
