type GoogleEventType =
  | "channel_watch_register"
  | "channel_watch_renew"
  | "channel_watch_no_webhook_url"
  | "channel_watch_token_mismatch"
  | "webhook_received"
  | "webhook_unauthenticated"
  | "webhook_duplicate"
  | "webhook_unknown_channel"
  | "import_sync_token_invalid"
  | "import_conflict_detected"
  | "import_external_block_created"
  | "import_outbound_revert"
  | "import_reservation_marker_mismatch_suppressed"
  | "outbound_write_success"
  | "outbound_write_failure"
  | "outbound_write_superseded"
  | "google_drift_alert"
  | "google_drift_check_failed"
  | "google_drift_alert_no_recipients"
  | "google_drift_alert_enqueue_failed"
  | "google_orphan_swept"
  | "google_orphan_sweep_failed"
  | "google_orphan_sweep_skipped"
  | "google_conflict_burst_alert"
  | "google_conflict_burst_check_failed"
  | "google_conflict_burst_alert_no_recipients"
  | "google_conflict_burst_alert_enqueue_failed";

type GoogleEventOutcome = "success" | "failure" | "noop" | "retry";

export type GoogleErrorClass =
  | "google_auth_failure"
  | "google_quota_exceeded"
  | "google_api_unavailable"
  | "sync_token_invalid"
  | "sync_token_missing"
  | "channel_token_mismatch"
  | "conflict_detected"
  | "fingerprint_mismatch"
  | "webhook_unauthenticated"
  | "unexpected";

export interface LogGoogleEventInput {
  event_type: GoogleEventType;
  outcome: GoogleEventOutcome;
  calendar_id?: string;
  store_id?: string;
  dedupe_key?: string;
  conflict_type?: string;
  error_class?: GoogleErrorClass;
  google_tracked_count?: number;
  d1_tracked_count?: number;
  drift?: number;
  swept_count?: number;
  grace_seconds?: number;
  conflict_count?: number;
  threshold?: number;
  window_minutes?: number;
  // Free-form error message (only used by *_failed events). Passed through
  // the same redactor as other strings so tokens / phone numbers / keys
  // are stripped before the line lands in Cloudflare Logs.
  error_message?: string;
}

const acceptCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;

import {
  isCalendarIdShape,
  isSensitiveContextKey,
  LINE_USER_ID_PATTERN,
  redactEmailsInString,
  redactPhonesInString,
  SERVICE_IDENTIFIER_KEY_PATTERN
} from "./pii-normalize";

const BEARER_PATTERN = /Bearer\s+[A-Z0-9._~+/-]+=*/gi;
const QUERY_TOKEN_PATTERN = /([?&])([^?=&\s"']+)=/g;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g;
const INLINE_JSON_KEY_PATTERN = /"((?:[a-z0-9_-]|\\u[\da-f]{4}){1,64})"\s*:\s*/gi;
const JSON_VALUE_CLOSERS: Readonly<Record<string, string>> = { "{": "}", "[": "]" };

function redactQueryParameter(match: string, separator: string, key: string): string {
  try {
    return isSensitiveContextKey(decodeURIComponent(key)) ? `${separator}${key}=[REDACTED]` : match;
  } catch {
    return `${separator}${key}=[REDACTED]`;
  }
}

function redactQueryParameters(value: string): string {
  const queries = new RegExp(QUERY_TOKEN_PATTERN);
  const delimiter = /[&\s"']/g;
  const parts: string[] = [];
  let copiedUntil = 0;
  let match: RegExpExecArray | null;
  while ((match = queries.exec(value)) !== null) {
    const replacement = redactQueryParameter(match[0], match[1], match[2]);
    if (replacement === match[0]) continue;
    delimiter.lastIndex = queries.lastIndex;
    const end = delimiter.exec(value)?.index ?? value.length;
    parts.push(value.slice(copiedUntil, match.index), replacement);
    copiedUntil = end;
    queries.lastIndex = end;
  }
  parts.push(value.slice(copiedUntil));
  return parts.join("");
}

function jsonStringEnd(value: string, start: number): number {
  for (let index = start + 1; index < value.length; index += 1) {
    if (value[index] === "\\") index += 1;
    else if (value[index] === '"') return index + 1;
  }
  return value.length;
}

function jsonValueEnd(value: string, start: number): number {
  if (value[start] === '"') return jsonStringEnd(value, start);
  if (!JSON_VALUE_CLOSERS[value[start]]) {
    const delimiter = /[,}\]\s]/g;
    delimiter.lastIndex = start;
    return delimiter.exec(value)?.index ?? value.length;
  }
  const closers: string[] = [];
  let index = start;
  while (index < value.length) {
    const char = value[index];
    if (char === '"') index = jsonStringEnd(value, index) - 1;
    else if (JSON_VALUE_CLOSERS[char]) closers.push(JSON_VALUE_CLOSERS[char]);
    else if (char === "}" || char === "]") {
      if (closers.pop() !== char) return value.length;
      if (closers.length === 0) return index + 1;
    }
    index += 1;
  }
  // A truncated/malformed sensitive value must not expose its remaining text.
  return value.length;
}

function redactJsonFields(value: string): string {
  const fields = new RegExp(INLINE_JSON_KEY_PATTERN);
  const boundary = /\S/g;
  const parts: string[] = [];
  let copiedUntil = 0;
  let match: RegExpExecArray | null;
  while ((match = fields.exec(value)) !== null) {
    const key = match[1].replace(/\\u([\da-f]{4})/gi, (_escape, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)));
    if (!isSensitiveContextKey(key)) continue;
    let end = jsonValueEnd(value, fields.lastIndex);
    boundary.lastIndex = end;
    const next = boundary.exec(value)?.[0];
    // An ambiguous suffix can still belong to the secret in malformed diagnostics.
    if (next && !",]}".includes(next)) end = value.length;
    parts.push(value.slice(copiedUntil, match.index), '"[REDACTED]":"[REDACTED]"');
    copiedUntil = end;
    // Skip the complete value once, including nested containers and strings.
    fields.lastIndex = end;
  }
  parts.push(value.slice(copiedUntil));
  return parts.join("");
}

const MAX_STRING_LENGTH = 256;

const VALID_ERROR_CLASSES: ReadonlySet<string> = new Set<GoogleErrorClass>([
  "google_auth_failure",
  "google_quota_exceeded",
  "google_api_unavailable",
  "sync_token_invalid",
  "sync_token_missing",
  "channel_token_mismatch",
  "conflict_detected",
  "fingerprint_mismatch",
  "webhook_unauthenticated",
  "unexpected"
]);

function redactString(value: string): string {
  let result = redactQueryParameters(value
    .replace(PRIVATE_KEY_PATTERN, "[REDACTED]")
    .replace(BEARER_PATTERN, "[REDACTED]"));
  result = redactPhonesInString(result, "[REDACTED]");
  LINE_USER_ID_PATTERN.lastIndex = 0;
  result = result.replace(LINE_USER_ID_PATTERN, "[REDACTED]");
  result = redactEmailsInString(result, "[REDACTED]");
  result = redactJsonFields(result);
  // Code-point aware truncate so surrogate pairs (emoji / CJK Extension B+)
  // aren't split mid-character — preserves valid Unicode in Cloudflare Logs.
  const codePoints = Array.from(result);
  if (codePoints.length > MAX_STRING_LENGTH) {
    result = codePoints.slice(0, MAX_STRING_LENGTH).join("") + "…(truncated)";
  }
  return result;
}

export function sanitizeValue(key: string, value: unknown): unknown {
  if (isSensitiveContextKey(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    if (
      SERVICE_IDENTIFIER_KEY_PATTERN.test(key) &&
      isCalendarIdShape(value)
    ) {
      // Well-formed service identifier (calendar_id). Skip PII pattern
      // redaction so Gmail-shaped primary-calendar IDs (e.g. `store@gmail.com`)
      // stay intact for operator correlation. Anything failing the shape
      // check (whitespace, Bearer noise, PEM body) falls through to full
      // redactString below. Code-point aware truncate to preserve surrogate
      // pairs in long identifiers (unlikely but cheap to handle).
      const valueCodePoints = Array.from(value);
      return valueCodePoints.length > MAX_STRING_LENGTH
        ? valueCodePoints.slice(0, MAX_STRING_LENGTH).join("") + "…(truncated)"
        : value;
    }
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeValue(String(index), item));
  }
  if (typeof value === "object" && value !== null) {
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      sanitized[k] = sanitizeValue(k, v);
    }
    return sanitized;
  }
  return value;
}

function addStrField(out: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value !== undefined) out[key] = sanitizeValue(key, value);
}

function addCountField(out: Record<string, unknown>, key: string, raw: number | undefined): void {
  const v = acceptCount(raw);
  if (v !== undefined) out[key] = v;
}

export function sanitize(input: LogGoogleEventInput): Record<string, unknown> {
  const result: Record<string, unknown> = {
    event_type: input.event_type,
    outcome: input.outcome
  };
  addStrField(result, "calendar_id", input.calendar_id);
  addStrField(result, "store_id", input.store_id);
  addStrField(result, "dedupe_key", input.dedupe_key);
  addStrField(result, "conflict_type", input.conflict_type);
  if (input.error_class !== undefined) {
    result.error_class = VALID_ERROR_CLASSES.has(input.error_class)
      ? input.error_class
      : "unexpected";
  }
  addCountField(result, "google_tracked_count", input.google_tracked_count);
  addCountField(result, "d1_tracked_count", input.d1_tracked_count);
  addCountField(result, "drift", input.drift);
  addCountField(result, "swept_count", input.swept_count);
  addCountField(result, "grace_seconds", input.grace_seconds);
  addCountField(result, "conflict_count", input.conflict_count);
  addCountField(result, "threshold", input.threshold);
  addCountField(result, "window_minutes", input.window_minutes);
  addStrField(result, "error_message", input.error_message);
  return result;
}

export function logGoogleEvent(input: LogGoogleEventInput): void {
  const payload = {
    ...sanitize(input),
    ts: new Date().toISOString()
  };
  console.log(JSON.stringify(payload));
}
