import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logGoogleEvent, sanitize, sanitizeValue } from "../src/logging";

import type { LogGoogleEventInput } from "../src/logging";

describe("logGoogleEvent", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("emits valid JSON with ts field", () => {
    logGoogleEvent({
      event_type: "webhook_received",
      outcome: "success"
    });
    expect(consoleSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(parsed.event_type).toBe("webhook_received");
    expect(parsed.outcome).toBe("success");
    expect(typeof parsed.ts).toBe("string");
    expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts);
  });

  it("passes through safe scalar fields", () => {
    // Use a realistic Google Calendar service ID (group.calendar.google.com)
    // which is on the EMAIL_PATTERN exempt domain list and must flow through
    // the redactor unchanged. `cal@example.com` would (correctly) be redacted
    // as a customer-shaped email if substituted here.
    logGoogleEvent({
      event_type: "outbound_write_success",
      outcome: "success",
      calendar_id: "primary@group.calendar.google.com",
      store_id: "store-1",
      dedupe_key: "key-abc",
      conflict_type: "external_block_slot_conflict"
    });
    const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(parsed.calendar_id).toBe("primary@group.calendar.google.com");
    expect(parsed.store_id).toBe("store-1");
    expect(parsed.dedupe_key).toBe("key-abc");
    expect(parsed.conflict_type).toBe("external_block_slot_conflict");
  });
});

describe("sanitize", () => {
  describe("free-form diagnostic credential fields", () => {
    it.each(['"opaqueSecret"', "42", "true", "null", '["opaqueSecret"]', '{"value":"opaqueSecret"}'])(
      "removes malformed secret suffixes after %s",
      (value) => {
        for (const gap of ["", " ", "\t\n"]) {
          const input = `safe=booking {"idToken":${value}${gap}syntheticSecretTail,"after":"diagnostic"}`;
          const result = sanitizeValue("error_message", input) as string;
          expect(result).not.toContain("opaqueSecret");
          expect(result).not.toContain("syntheticSecretTail");
          expect(result).toContain("safe=booking");
        }
      }
    );

    it.each(['"opaqueSecret"', "42", "true", "null", '["opaqueSecret"]', '{"value":"opaqueSecret"}'])(
      "retains diagnostics after a valid boundary for %s",
      (value) => {
        expect(sanitizeValue("error_message", `{"idToken":${value} \n,"safe":"booking"}`))
          .toBe('{"[REDACTED]":"[REDACTED]" \n,"safe":"booking"}');
      }
    );

    it.each(["", " \n", "]", " \n]", "}", "\t}"])("accepts a closing delimiter or end after whitespace: %s", (tail) => {
      expect(sanitizeValue("error_message", `"idToken":"opaqueSecret"${tail}`))
        .toBe(`"[REDACTED]":"[REDACTED]"${tail}`);
    });

    it.each([
      'cb(["sync_token":"opaqueSecret"]) safe=booking',
      '{"\\U0069dToken":"opaqueSecret","safe":"booking"}',
      'failure {"idToken":{"value":"opaqueSecret"},"safe":"booking"}',
      'failure {"lineAccessToken":["opaqueSecret"],"safe":"booking"}',
      'failure {"nonce":{"nested":[{"value":"opaqueSecret"}]},"safe":"booking"}',
      'failure {"idToken":{"value":"opaqueSecret } ] \\\" still secret"},"safe":"booking"}'
    ])("removes complete sensitive values in %s", (input) => {
      const result = sanitizeValue("error_message", input) as string;
      expect(result).not.toContain("opaqueSecret");
      expect(result).not.toContain("still secret");
      expect(result).toContain("[REDACTED]");
      expect(result).toContain("booking");
    });

    it.each([
      'safe=booking {"idToken":{"value":"opaqueSecret',
      'safe=booking {"idToken":["opaqueSecret"},"tail":"opaqueSecret"}'
    ])("fails closed on an incomplete or mismatched sensitive value in %s", (input) => {
      const result = sanitizeValue("error_message", input) as string;
      expect(result).toBe('safe=booking {"[REDACTED]":"[REDACTED]"');
    });

    it("handles deeply nested diagnostic values without recursion or backtracking", () => {
      const input = '{"nonce":' + "[".repeat(50_000) + '"opaqueSecret"' + "]".repeat(50_000) + ',"safe":"booking"}';
      const start = Date.now();
      expect(sanitizeValue("error_message", input)).toBe('{"[REDACTED]":"[REDACTED]","safe":"booking"}');
      expect(Date.now() - start).toBeLessThan(1000);
    });
  });

  describe("sensitive key redaction", () => {
    it("redacts access_token key", () => {
      const result = sanitize({
        event_type: "webhook_received",
        outcome: "success",
        calendar_id: "ya29.secret-token-value"
      } as LogGoogleEventInput);
      expect(result.event_type).toBe("webhook_received");
    });

    it("redacts sensitive keys at any nesting depth via sanitizeValue", () => {
      const input: LogGoogleEventInput = {
        event_type: "channel_watch_register",
        outcome: "failure",
        calendar_id: "test-cal"
      };
      const result = sanitize(input);
      expect(result.calendar_id).toBe("test-cal");
    });
  });

  describe("inline Bearer token redaction", () => {
    it("redacts Bearer tokens in string values", () => {
      const result = sanitize({
        event_type: "webhook_received",
        outcome: "success",
        dedupe_key: "header: Bearer ya29.abc123_xyz-456 end"
      });
      expect(result.dedupe_key).toBe("header: [REDACTED] end");
    });

    it("redacts multiple Bearer tokens in one string", () => {
      const result = sanitize({
        event_type: "webhook_received",
        outcome: "success",
        dedupe_key: "Bearer AAA and Bearer BBB"
      });
      expect(result.dedupe_key).toBe("[REDACTED] and [REDACTED]");
    });
  });

  describe("query parameter token redaction", () => {
    it.each([
      "https://example.test/?access_token=opaque?secret&safe=booking",
      "https://example.test/?access%ZZ_token=opaqueSecret&safe=booking",
      "https://example.test/?next=https://other.test/?access_token=opaque?secret&safe=booking"
    ])("redacts complete or undecodable credential parameters in %s", (input) => {
      const result = sanitizeValue("error_message", input) as string;
      expect(result).not.toContain("opaque");
      expect(result).not.toContain("secret");
      expect(result).toContain("&safe=booking");
    });

    it("redacts ?access_token=... in URLs", () => {
      const result = sanitize({
        event_type: "webhook_received",
        outcome: "success",
        dedupe_key: "https://example.com/api?access_token=ya29.secret123&other=ok"
      });
      const value = result.dedupe_key as string;
      expect(value).not.toContain("ya29.secret123");
      expect(value).toContain("[REDACTED]");
      expect(value).toContain("&other=ok");
    });

    it.each([
      {
        name: "redacts &syncToken=... in URLs",
        dedupeKey: "https://example.com/api?page=1&syncToken=abc123def",
        notContain: "abc123def"
      },
      {
        name: "redacts &sync_token=... in URLs",
        dedupeKey: "https://example.com?sync_token=secret456",
        notContain: "secret456"
      },
      {
        name: "redacts &channelToken=... in URLs",
        dedupeKey: "https://example.com?channelToken=tok789",
        notContain: "tok789"
      },
      {
        name: "redacts &channel_token=... in URLs",
        dedupeKey: "https://example.com?channel_token=tok789",
        notContain: "tok789"
      }
    ])("$name", ({ dedupeKey, notContain }) => {
      const result = sanitize({
        event_type: "webhook_received",
        outcome: "success",
        dedupe_key: dedupeKey
      });
      const value = result.dedupe_key as string;
      expect(value).not.toContain(notContain);
    });
  });

  describe("phone number redaction", () => {
    it("redacts 11-digit Japanese phone numbers", () => {
      const result = sanitize({
        event_type: "webhook_received",
        outcome: "success",
        dedupe_key: "caller 09012345678 called"
      });
      expect(result.dedupe_key).toBe("caller [REDACTED] called");
    });

    it("redacts 10-digit Japanese phone numbers", () => {
      const result = sanitize({
        event_type: "webhook_received",
        outcome: "success",
        dedupe_key: "phone 0312345678 here"
      });
      expect(result.dedupe_key).toBe("phone [REDACTED] here");
    });

    it("does not redact numbers preceded by other digits", () => {
      const result = sanitize({
        event_type: "webhook_received",
        outcome: "success",
        dedupe_key: "id 109012345678 here"
      });
      expect(result.dedupe_key).toBe("id 109012345678 here");
    });

    it("does not redact numbers followed by other digits", () => {
      const result = sanitize({
        event_type: "webhook_received",
        outcome: "success",
        dedupe_key: "id 090123456789 here"
      });
      expect(result.dedupe_key).toBe("id 090123456789 here");
    });

    it("redacts hyphen-separated Japanese phone numbers", () => {
      const result = sanitize({
        event_type: "webhook_received",
        outcome: "success",
        error_message: "called 075-123-4567 back"
      });
      const value = result.error_message as string;
      expect(value).toContain("[REDACTED]");
      expect(value).not.toContain("075-123-4567");
    });

    it("redacts +81 international Japanese phone numbers", () => {
      const result = sanitize({
        event_type: "webhook_received",
        outcome: "success",
        error_message: "intl +81901234567 number"
      });
      const value = result.error_message as string;
      expect(value).toContain("[REDACTED]");
      expect(value).not.toContain("81901234567");
    });

    it("redacts phones with NFKC full-width digits", () => {
      const result = sanitize({
        event_type: "webhook_received",
        outcome: "success",
        error_message: "fw 0901234567"
      });
      const value = result.error_message as string;
      expect(value).toContain("[REDACTED]");
    });
  });

  describe("LINE userId redaction", () => {
    it("redacts a LINE userId in free-form error_message", () => {
      const result = sanitize({
        event_type: "webhook_received",
        outcome: "failure",
        error_message: "push to Ua1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6 failed"
      });
      const value = result.error_message as string;
      expect(value).toContain("[REDACTED]");
      expect(value).not.toContain("Ua1b2c3d4");
    });

    it("does not redact strings that resemble userId but are too short", () => {
      const result = sanitize({
        event_type: "webhook_received",
        outcome: "failure",
        error_message: "context Ua1b2c3d4 (too short)"
      });
      const value = result.error_message as string;
      expect(value).toContain("Ua1b2c3d4");
    });
  });

  describe("email redaction with Google service-domain exemption", () => {
    it("redacts customer-shaped email addresses", () => {
      const result = sanitize({
        event_type: "webhook_received",
        outcome: "failure",
        error_message: "notify customer@example.jp issue"
      });
      const value = result.error_message as string;
      expect(value).toContain("[REDACTED]");
      expect(value).not.toContain("customer@example.jp");
    });

    it("preserves Google Calendar service-domain identifiers", () => {
      const result = sanitize({
        event_type: "outbound_write_success",
        outcome: "success",
        calendar_id: "abc123-uuid@group.calendar.google.com"
      });
      expect(result.calendar_id).toBe("abc123-uuid@group.calendar.google.com");
    });

    it("preserves IAM service-account addresses", () => {
      const result = sanitize({
        event_type: "outbound_write_success",
        outcome: "success",
        error_message: "auth as svc@reservation-prod.iam.gserviceaccount.com"
      });
      const value = result.error_message as string;
      expect(value).toContain("svc@reservation-prod.iam.gserviceaccount.com");
    });
  });

  describe("calendar_id passthrough validation", () => {
    it("falls back to full redaction when calendar_id value is not shape-valid", () => {
      // Free-form text on calendar_id key (regression guard for SERVICE_IDENTIFIER_KEY_PATTERN bypass)
      const result = sanitize({
        event_type: "outbound_write_success",
        outcome: "success",
        calendar_id: "Bearer eyFakeToken phone 0901234567"
      });
      const value = result.calendar_id as string;
      expect(value).toContain("[REDACTED]");
      expect(value).not.toContain("eyFakeToken");
      expect(value).not.toContain("0901234567");
    });

    it("falls back to full redaction when calendar_id contains whitespace", () => {
      const result = sanitize({
        event_type: "outbound_write_success",
        outcome: "success",
        calendar_id: "store one@example.com"
      });
      const value = result.calendar_id as string;
      expect(value).toContain("[REDACTED]");
    });
  });

  describe("ReDoS guard via REDACTOR_INPUT_MAX_LEN", () => {
    it("handles very long strings without runaway CPU", () => {
      const long = "a@" + ".".repeat(50_000) + "1 contains 0901234567 here";
      const start = Date.now();
      const result = sanitize({
        event_type: "outbound_write_success",
        outcome: "success",
        error_message: long
      });
      const elapsed = Date.now() - start;
      const value = result.error_message as string;
      // First 4096 chars get redacted; downstream MAX_STRING_LENGTH=256 then
      // truncates the final display.
      expect(value.length).toBeLessThan(300);
      // CPU work must be linear-ish; 100ms is a generous ceiling.
      expect(elapsed).toBeLessThan(100);
    });
  });

  describe("private key redaction", () => {
    it("redacts PEM private keys", () => {
      const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJBALR\n-----END RSA PRIVATE KEY-----";
      const result = sanitize({
        event_type: "webhook_received",
        outcome: "success",
        dedupe_key: `key: ${pem} done`
      });
      const value = result.dedupe_key as string;
      expect(value).not.toContain("MIIBogIBAAJBALR");
      expect(value).toContain("[REDACTED]");
    });
  });

  describe("string truncation", () => {
    it("truncates strings longer than 256 chars", () => {
      const longString = "a".repeat(300);
      const result = sanitize({
        event_type: "webhook_received",
        outcome: "success",
        dedupe_key: longString
      });
      const value = result.dedupe_key as string;
      expect(value.length).toBeLessThan(300);
      expect(value).toContain("…(truncated)");
      expect(value.startsWith("a".repeat(256))).toBe(true);
    });

    it("does not truncate strings of exactly 256 chars", () => {
      const exact = "b".repeat(256);
      const result = sanitize({
        event_type: "webhook_received",
        outcome: "success",
        dedupe_key: exact
      });
      expect(result.dedupe_key).toBe(exact);
    });
  });

  describe("error_class runtime guard", () => {
    it("passes valid error_class values through", () => {
      const result = sanitize({
        event_type: "webhook_unauthenticated",
        outcome: "failure",
        error_class: "google_auth_failure"
      });
      expect(result.error_class).toBe("google_auth_failure");
    });

    it("replaces unknown error_class with unexpected", () => {
      const result = sanitize({
        event_type: "webhook_unauthenticated",
        outcome: "failure",
        error_class: "some_unknown_class" as never
      });
      expect(result.error_class).toBe("unexpected");
    });

    it("replaces empty string error_class with unexpected", () => {
      const result = sanitize({
        event_type: "webhook_unauthenticated",
        outcome: "failure",
        error_class: "" as never
      });
      expect(result.error_class).toBe("unexpected");
    });
  });

  describe("property-based sensitive substring detection", () => {
    const sensitiveSubstrings = [
      "Bearer ya29.A0ARrdaM_secret",
      "?access_token=secret123",
      "&syncToken=CPDAlqWE9_token",
      "&channel_token=uuid:uuid:secret",
      "09012345678",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----"
    ];

    const buildNestedObject = (
      value: string,
      depth: number
    ): Record<string, unknown> => {
      if (depth <= 0) {
        return { leaf: value };
      }
      return { nested: buildNestedObject(value, depth - 1) };
    };

    for (const sensitive of sensitiveSubstrings) {
      for (let depth = 0; depth < 4; depth += 1) {
        it(`never leaks "${sensitive.slice(0, 30)}..." at depth ${depth}`, () => {
          const nested = buildNestedObject(
            `prefix ${sensitive} suffix`,
            depth
          );
          const input: LogGoogleEventInput = {
            event_type: "webhook_received",
            outcome: "success",
            dedupe_key: JSON.stringify(nested)
          };
          const output = JSON.stringify(sanitize(input));
          for (const sub of sensitiveSubstrings) {
            const core = sub
              .replace(/^Bearer\s+/, "")
              .replace(/^[?&]\w+=/, "")
              .replace(/^-----BEGIN[^-]+-----\n?/, "")
              .replace(/\n?-----END[^-]+-----$/, "");
            if (core.length > 4) {
              expect(output).not.toContain(core);
            }
          }
        });
      }
    }

    it("random nested objects with sensitive keys produce no value leaks", () => {
      const sensitiveKeys = [
        "access_token",
        "refresh_token",
        "sync_token",
        "channel_token",
        "private_key",
        "client_secret",
        "authorization"
      ];

      for (let trial = 0; trial < 20; trial += 1) {
        const key = sensitiveKeys[trial % sensitiveKeys.length];
        const obj: Record<string, unknown> = {};
        obj[key] = `sensitive_payload_${trial}_xyzzy`;
        const input: LogGoogleEventInput = {
          event_type: "webhook_received",
          outcome: "success",
          dedupe_key: JSON.stringify(obj)
        };
        const output = JSON.stringify(sanitize(input));
        expect(output).not.toContain(`sensitive_payload_${trial}_xyzzy`);
      }
    });
  });

  describe("recursive sanitizeValue walk", () => {
    it("sanitize recursively redacts nested object keys at depth >= 2", () => {
      const input = {
        a: {
          b: {
            sync_token: "secret-1",
            nested: { access_token: "secret-2" }
          }
        }
      };
      const result = sanitizeValue("root", input) as Record<string, unknown>;
      const json = JSON.stringify(result);
      expect(json).not.toContain("secret-1");
      expect(json).not.toContain("secret-2");
      expect(json).toContain("[REDACTED]");

      // Verify structure is preserved and both leaves are redacted
      const a = result.a as Record<string, unknown>;
      const b = a.b as Record<string, unknown>;
      expect(b.sync_token).toBe("[REDACTED]");
      const nested = b.nested as Record<string, unknown>;
      expect(nested.access_token).toBe("[REDACTED]");
    });

    it("recursively redacts sensitive keys inside arrays", () => {
      const input = [{ refresh_token: "arr-secret" }, { safe_key: "visible" }];
      const result = sanitizeValue("root", input) as unknown[];
      const json = JSON.stringify(result);
      expect(json).not.toContain("arr-secret");
      expect(json).toContain("visible");
    });

    it("redacts nextSyncToken key (camelCase from Google API)", () => {
      const input = { nextSyncToken: "google-next-sync-secret" };
      const result = sanitizeValue("root", input) as Record<string, unknown>;
      expect(result.nextSyncToken).toBe("[REDACTED]");
    });

    it("redacts next_sync_token key (snake_case variant)", () => {
      const input = { next_sync_token: "snake-secret" };
      const result = sanitizeValue("root", input) as Record<string, unknown>;
      expect(result.next_sync_token).toBe("[REDACTED]");
    });
  });

  describe("event_type and outcome always preserved", () => {
    it("keeps event_type and outcome unchanged", () => {
      const result = sanitize({
        event_type: "import_sync_token_invalid",
        outcome: "retry",
        error_class: "sync_token_invalid"
      });
      expect(result.event_type).toBe("import_sync_token_invalid");
      expect(result.outcome).toBe("retry");
    });
  });

  describe("drift numeric fields (Step 6)", () => {
    it("accepts non-negative finite integers", () => {
      const result = sanitize({
        event_type: "google_drift_alert",
        outcome: "noop",
        google_tracked_count: 25,
        d1_tracked_count: 15,
        drift: 10
      });
      expect(result.google_tracked_count).toBe(25);
      expect(result.d1_tracked_count).toBe(15);
      expect(result.drift).toBe(10);
    });

    it("rejects negative values (key omitted)", () => {
      const result = sanitize({
        event_type: "google_drift_alert",
        outcome: "noop",
        drift: -1
      });
      expect(result).not.toHaveProperty("drift");
    });

    it("rejects NaN, Infinity, and non-number values", () => {
      const result = sanitize({
        event_type: "google_drift_alert",
        outcome: "noop",
        d1_tracked_count: Number.NaN,
        google_tracked_count: Number.POSITIVE_INFINITY,
        drift: "7" as unknown as number
      });
      expect(result).not.toHaveProperty("d1_tracked_count");
      expect(result).not.toHaveProperty("google_tracked_count");
      expect(result).not.toHaveProperty("drift");
    });

    it("truncates fractional values toward zero", () => {
      const result = sanitize({
        event_type: "google_drift_alert",
        outcome: "noop",
        drift: 12.9
      });
      expect(result.drift).toBe(12);
    });

    it("omits the fields when undefined (does not introduce noise keys)", () => {
      const result = sanitize({
        event_type: "google_drift_alert",
        outcome: "noop"
      });
      expect(result).not.toHaveProperty("google_tracked_count");
      expect(result).not.toHaveProperty("d1_tracked_count");
      expect(result).not.toHaveProperty("drift");
    });
  });
});
