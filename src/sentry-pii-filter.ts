/**
 * PII redaction for Sentry events (beforeSend / beforeBreadcrumb).
 *
 * Three-layer guard:
 *   1. sendDefaultPii: false (SDK auto-collection disabled)
 *   2. This filter — deep-scrubs event payloads before upload
 *   3. Capture callsites never put raw PII in contexts/extra
 *
 * Pattern primitives + phone normalisation live in src/pii-normalize.ts and
 * are shared with src/logging.ts. src/google/calendar-sync.ts intentionally
 * keeps its own copy (touch-prohibited hard constraint).
 */
import type { ErrorEvent, Breadcrumb } from "@sentry/cloudflare";

import { sanitizeValue } from "./logging";
import {
  isSensitiveContextKey,
  LINE_USER_ID_PATTERN,
  redactEmailsInString,
  redactPhonesInString,
  redactPushEndpoints
} from "./pii-normalize";

function redactStringExtended(value: string): string {
  // Phase 1: phone normalize + redact first so the [REDACTED_PHONE] label
  // survives. sanitizeValue would otherwise replace 0\d{9,10} with the
  // generic [REDACTED] sentinel from logging.ts.
  let result = redactPhonesInString(value, "[REDACTED_PHONE]");
  LINE_USER_ID_PATTERN.lastIndex = 0;
  result = result.replace(LINE_USER_ID_PATTERN, "[REDACTED_LINE_USER_ID]");
  result = redactEmailsInString(result, "[REDACTED_EMAIL]");
  // Web Push endpoints are bearer-equivalent: sanitizeValue below only knows
  // about Bearer headers and `?access_token=`, and the token here is a path
  // segment, so it needs its own pass.
  result = redactPushEndpoints(result);
  // Phase 2: delegate to logging.ts sanitizeValue so Bearer tokens,
  // ?access_token= / sync_token / channel_token query strings, PEM private
  // keys, and inline-JSON secret blobs are stripped before Sentry sees them.
  const base = sanitizeValue("", result);
  return typeof base === "string" ? base : result;
}

// ── recursive deep scrub ─────────────────────────────────────────────

/**
 * Self-contained recursive scrubber. Does NOT delegate to sanitizeValue
 * from src/logging.ts because that function's extended blocklist does
 * not cover LINE userId, email, or the wider isSensitiveContextKey set.
 */
function deepScrub(value: unknown, key: string = ""): unknown {
  if (key && isSensitiveContextKey(key)) return "[REDACTED]";
  // Note: deepScrub deliberately does NOT honor SERVICE_IDENTIFIER_KEY_PATTERN
  // because the Sentry path walks arbitrary capture context shapes — any
  // misuse putting a customer email under a nested `calendar_id` key would
  // leak through. Calendar IDs hitting the Google-service or IAM exempt
  // domains in EMAIL_PATTERN still pass through redactEmailsInString; only
  // Gmail-shaped primary calendar IDs (e.g. `store@gmail.com`) get redacted
  // to [REDACTED_EMAIL] in Sentry events. The typed input flow through
  // src/logging.ts retains the SERVICE_IDENTIFIER_KEY_PATTERN bypass because
  // LogGoogleEventInput.calendar_id is a structurally constrained field.
  if (typeof value === "string") return redactStringExtended(value);
  if (Array.isArray(value)) return value.map((item, i) => deepScrub(item, String(i)));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepScrub(v, k);
    }
    return out;
  }
  return value;
}

// ── Sentry hooks ─────────────────────────────────────────────────────

type SentryRequest = NonNullable<ErrorEvent["request"]>;

function scrubPathSegment(segment: string): string {
  try {
    const decoded = decodeURIComponent(segment);
    const clean = redactEmailsInString(decoded, "[REDACTED_EMAIL]");
    // Keep safe escaping (including encoded slashes) and route templates intact.
    return clean === decoded ? segment : encodeURIComponent(clean);
  } catch {
    return "[REDACTED]";
  }
}

function scrubQuery(query: SentryRequest["query_string"]): SentryRequest["query_string"] {
  if (typeof query === "string") {
    const params = new URLSearchParams(query);
    const clean = new URLSearchParams();
    for (const [key, value] of params) clean.append(key, String(deepScrub(value, key)));
    return clean.toString();
  }
  // The SDK also represents queries as ordered pairs, including duplicate keys.
  if (Array.isArray(query)) return query.map(([key, value]) => [key, String(deepScrub(value, key))]);
  return deepScrub(query) as SentryRequest["query_string"];
}

/** Error and transaction events both receive request data from the SDK. */
export function scrubSentryRequest(request: ErrorEvent["request"]): void {
  if (!request) return;
  if (request.url) {
    try {
      const url = new URL(request.url);
      url.pathname = url.pathname.split("/").map(scrubPathSegment).join("/");
      if (url.search) url.search = scrubQuery(url.search) as string;
      request.url = redactStringExtended(url.toString());
    } catch {
      request.url = redactStringExtended(request.url);
    }
  }
  if (request.headers) request.headers = deepScrub(request.headers) as Record<string, string>;
  if (request.query_string !== undefined) request.query_string = scrubQuery(request.query_string);
  if (request.data !== undefined && request.data !== null) request.data = deepScrub(request.data);
}

export function scrubSentryEvent(event: ErrorEvent): ErrorEvent | null {
  if (event.message) event.message = redactStringExtended(event.message);
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (ex.value) ex.value = redactStringExtended(ex.value);
    }
  }
  if (event.extra) event.extra = deepScrub(event.extra) as Record<string, unknown>;
  if (event.contexts) {
    for (const [k, v] of Object.entries(event.contexts)) {
      event.contexts[k] = deepScrub(v, k) as Record<string, unknown>;
    }
  }
  scrubSentryRequest(event.request);
  return event;
}

export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.message) breadcrumb.message = redactStringExtended(breadcrumb.message);
  if (typeof breadcrumb.data?.url === "string") {
    const request = { url: breadcrumb.data.url };
    scrubSentryRequest(request);
    breadcrumb.data.url = request.url;
  }
  if (breadcrumb.data) breadcrumb.data = deepScrub(breadcrumb.data) as Record<string, unknown>;
  return breadcrumb;
}

// deepScrub is reused by the transaction-event normalizer in index.ts (beforeSend
// does not run for transaction events); the *_ForTest aliases stay for existing tests.
export { deepScrub, deepScrub as _deepScrubForTest, redactStringExtended as _redactStringExtendedForTest };
