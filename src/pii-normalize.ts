/**
 * Shared PII normalization + pattern constants.
 *
 * Three consumers:
 *  - src/logging.ts: redacts Cloudflare Logs payloads with bare `[REDACTED]` sentinels
 *  - src/sentry-pii-filter.ts: redacts Sentry event payloads with category labels
 *  - src/google/calendar-sync.ts: sanitizes customer names for Google Calendar summaries
 */

// LINE userId (Messaging API user identifier). Letter `U` + 32 hex chars.
export const LINE_USER_ID_PATTERN = /U[0-9a-fA-F]{32}/g;

// Conservative email pattern. Domain section uses atomic segment alternation
// `[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}` to avoid catastrophic
// backtracking the `[A-Za-z0-9.-]+` form would allow when given malicious
// "a@...........1" input. Combined with the REDACTOR_INPUT_MAX_LEN guard
// in redactor helpers, worst-case work is bounded to linear in the slice.
export const EMAIL_PATTERN =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/**
 * Maximum string length passed to PII redaction helpers. Long strings are
 * sliced into a redacted head + verbatim tail to keep regex work linear,
 * even when SonarCloud / downstream truncation has not yet capped length.
 * The choice of 4096 covers Cloudflare Logs default line length, normal
 * exception messages, and Sentry event payload fields while leaving CPU
 * budget intact (≈10ms worst-case on the chosen patterns).
 */
export const REDACTOR_INPUT_MAX_LEN = 4096;

// Non-ASCII dashes: U+2010 HYPHEN..U+2015 HORIZONTAL BAR, U+2212 MINUS,
// U+30FC KATAKANA-HIRAGANA PROLONGED SOUND MARK.
const NON_ASCII_DASHES = /[\u2010-\u2015\u2212\u30FC]/g;

// Phone-separator characters that humans insert: whitespace, parens, period,
// slash, dash/hyphen, plus, zero-width chars (U+200B..U+200F, U+2060).
const PHONE_SEPARATORS = /[\s()./\\\-+\u200B-\u200F\u2060]/g;

// Post-separator digit-only shape we recognise as a phone number:
//   - 10-11 digit 0-prefixed domestic (0751234567 Kyoto / 09012345678 mobile / 0312345678 Tokyo)
//   - 11-12 digit 81-prefixed international (+81 stripped of `+`)
const PHONE_DIGIT_RUN = /(?<!\d)(?:0\d{9,10}|81\d{9,10})(?!\d)/g;

// Candidate token: 8+ characters of digits + phone separators. Callers verify
// digit shape after separator removal to avoid false positives.
const PHONE_RUN_TOKEN = /[\d\s()./\\\-+\u200B-\u200F\u2060]{8,}/g;

/**
 * Keys whose values are service identifiers (Google Calendar ID, etc.) and
 * should NOT receive PII redaction even when their value happens to be
 * email-shaped (e.g. `someone@gmail.com` for a user's primary calendar).
 *
 * Calendar IDs are structurally identifiers, not free-form content, so they
 * can't legitimately carry customer phones, LINE userIds, or Bearer tokens.
 * Operators rely on the raw ID to correlate sync events.
 */
export const SERVICE_IDENTIFIER_KEY_PATTERN = /^calendar_?id$/i;

/**
 * Extended sensitive context-key blocklist (token/secret + LINE/customer PII
 * fields). Matched case-insensitively after stripping `-` / `_` separators
 * so `set-cookie`, `set_cookie`, and `setCookie` all hit the same entry.
 */
const SENSITIVE_KEYS_NORMALIZED: ReadonlySet<string> = new Set<string>([
  "accesstoken",
  "idtoken",
  "lineaccesstoken",
  "xlineidtoken",
  "xlineaccesstoken",
  "turnstiletoken",
  "nonce",
  "xlinenonce",
  "xlinesignature",
  "xgoogchanneltoken",
  "cfaccessclientsecret",
  "refreshtoken",
  "synctoken",
  "nextsynctoken",
  "channeltoken",
  "authorization",
  "privatekey",
  "clientsecret",
  "lineuserid",
  "recipientuserid",
  "recipientid",
  "recipientlineuserid",
  "lineidentityid",
  "displayname",
  "displaynamekana",
  "customerdisplayname",
  "customername",
  "customerphone",
  "customeremail",
  "phone",
  "phonenormalized",
  "phonehash",
  "email",
  "address",
  "location",
  "payloadjson",
  "consentsignaturehash",
  "providermessageid",
  "cookie",
  "setcookie",
  "cfaccessjwtassertion"
]);

export function isSensitiveContextKey(key: string): boolean {
  if (!key) return false;
  return SENSITIVE_KEYS_NORMALIZED.has(key.toLowerCase().replace(/[-_]/g, ""));
}

/** Normalize for PII matching: NFKC + dash normalization. */
export function normalizeForPii(value: string): string {
  return value.normalize("NFKC").replace(NON_ASCII_DASHES, "-");
}

/**
 * Replace phone-number-like digit runs (with or without separators) by `label`.
 *
 * Input is NFKC- and dash-normalised before matching so full-width digits,
 * hyphen-separated forms, and prolonged-sound-mark dashes all get caught.
 * Leading/trailing whitespace within the matched run is preserved around
 * the label so existing log message structure (e.g. "called X back" →
 * "called [REDACTED] back") survives the substitution.
 *
 * @param value string to scan
 * @param label replacement label (e.g. `[REDACTED]` or `[REDACTED_PHONE]`)
 */
export function redactPhonesInString(value: string, label: string): string {
  if (value.length > REDACTOR_INPUT_MAX_LEN) {
    const head = value.slice(0, REDACTOR_INPUT_MAX_LEN);
    const tail = value.slice(REDACTOR_INPUT_MAX_LEN);
    return redactPhonesInString(head, label) + tail;
  }
  const normalized = normalizeForPii(value);
  return normalized.replace(PHONE_RUN_TOKEN, (token) => {
    const digits = token.replace(PHONE_SEPARATORS, "");
    PHONE_DIGIT_RUN.lastIndex = 0;
    const matched = PHONE_DIGIT_RUN.test(digits);
    PHONE_DIGIT_RUN.lastIndex = 0;
    if (!matched) return token;
    const trimmedStart = token.trimStart();
    const trimmedEnd = token.trimEnd();
    const leadingWs = token.slice(0, token.length - trimmedStart.length);
    const trailingWs = token.slice(trimmedEnd.length);
    return `${leadingWs}${label}${trailingWs}`;
  });
}

// Email-like strings whose domain we treat as non-PII service identifiers
// (Google Calendar shared/import/resource calendars, iam service accounts).
// Calendar IDs commonly take the form `xxx@group.calendar.google.com` and
// should pass through redactors so operators can correlate sync events.
const EMAIL_EXEMPT_DOMAINS: ReadonlySet<string> = new Set([
  "group.calendar.google.com",
  "import.calendar.google.com",
  "resource.calendar.google.com",
  "calendar.google.com"
]);

/**
 * Replace customer-shaped email addresses with `label`, preserving
 * Google Calendar service-domain identifiers and iam service-account
 * addresses (non-PII).
 */
export function redactEmailsInString(value: string, label: string): string {
  if (value.length > REDACTOR_INPUT_MAX_LEN) {
    const head = value.slice(0, REDACTOR_INPUT_MAX_LEN);
    const tail = value.slice(REDACTOR_INPUT_MAX_LEN);
    return redactEmailsInString(head, label) + tail;
  }
  EMAIL_PATTERN.lastIndex = 0;
  return value.replace(EMAIL_PATTERN, (match) => {
    const atIdx = match.lastIndexOf("@");
    if (atIdx < 0) return match;
    const domain = match.slice(atIdx + 1).toLowerCase();
    if (EMAIL_EXEMPT_DOMAINS.has(domain)) return match;
    if (domain.endsWith(".iam.gserviceaccount.com")) return match;
    return label;
  });
}

/**
 * Web Push service hosts. Shared by two callers that must agree:
 * src/notifications/admin-push.ts (the allow-list of hosts this Worker will
 * POST a push to) and the Sentry redaction below.
 */
export const PUSH_SERVICE_HOSTS: readonly string[] = [
  "web.push.apple.com", // Safari / iOS
  "fcm.googleapis.com", // Chrome
  "updates.push.services.mozilla.com" // Firefox
];

/** Edge/Windows shards the host per region (wns2-*.notify.windows.com). */
export const PUSH_SERVICE_HOST_SUFFIX = ".notify.windows.com";

export const isPushServiceHost = (hostname: string): boolean =>
  PUSH_SERVICE_HOSTS.includes(hostname) || hostname.endsWith(PUSH_SERVICE_HOST_SUFFIX);

/**
 * A push endpoint is a CAPABILITY URL: its path carries a per-device token, and
 * anyone holding the whole URL can deliver a notification to that device. The
 * Sentry SDK attaches the full URL of every outbound fetch to its spans and
 * breadcrumbs, so without this the token would ship on the first push failure.
 * The origin is kept — knowing a request went to Apple's push service is what
 * makes the trace useful, and it is not the secret part.
 */
const PUSH_ENDPOINT_PATTERN = new RegExp(
  // Built from the host list above, not a second hand-written copy of it: a push
  // service added to the allow-list but missed in the regex would ship that
  // provider's capability URLs to Sentry.
  // The optional port matters: normalizePushEndpoint accepts one, so a regex
  // that only knows `host/path` would let that spelling through unredacted.
  String.raw`(https://[a-z0-9.-]*(?:${[...PUSH_SERVICE_HOSTS, PUSH_SERVICE_HOST_SUFFIX.slice(1)]
    .map((host) => host.replaceAll(".", String.raw`\.`))
    .join("|")})(?::\d+)?)/[^\s"'\\]+`,
  "gi"
);

export function redactPushEndpoints(value: string): string {
  PUSH_ENDPOINT_PATTERN.lastIndex = 0;
  return value.replace(PUSH_ENDPOINT_PATTERN, "$1/[REDACTED_PUSH_ENDPOINT]");
}

/**
 * Detect whether a value is a Google Calendar / IAM / Gmail-shaped service
 * identifier safe to passthrough redactors. Calendar IDs are well-formed
 * `<local-part>@<domain>` strings without whitespace or Bearer/PEM noise,
 * so anything failing this shape check must fall back to full PII redaction.
 *
 * Used to gate SERVICE_IDENTIFIER_KEY_PATTERN bypasses in src/logging.ts
 * sanitizeValue and src/sentry-pii-filter.ts deepScrub.
 */
const CALENDAR_ID_SHAPE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

export function isCalendarIdShape(value: string): boolean {
  if (value.length === 0 || value.length > 256) return false;
  return CALENDAR_ID_SHAPE.test(value);
}

// Calendar-summary PII sanitization (Phase E consolidation from calendar-sync.ts)

/** Simple `@` presence check — any `@` in a normalised name is email-like PII. */
export const EMAIL_LIKE_PATTERN = /@/;

/**
 * Control characters to strip from display names before any PII check.
 *
 * Covers:
 * - C0 controls (U+0000..U+001F) + DEL (U+007F)
 * - Line / paragraph separators (U+2028..U+2029)
 * - Arabic Letter Mark (U+061C) — Bidi_Control
 * - LRM / RLM (U+200E..U+200F) — directional marks (already in the
 *   phone separator set, listed here too so any callsite that uses
 *   CONTROL_CHARS_PATTERN alone gets full Bidi_Control coverage)
 * - Bidi format controls U+202A..U+202E (LRE / RLE / PDF / LRO / RLO)
 * - Bidi isolates U+2066..U+2069 (LRI / RLI / FSI / PDI)
 * - BOM / zero-width no-break space (U+FEFF)
 *
 * Bidi controls must be stripped here (not only via the phone separator
 * pattern) because they can be injected anywhere in a display name to
 * split visible digits or dates apart and bypass PHONE_LIKE_DIGIT_RUN or
 * DATE_ANY_PATTERN.
 */
export const CONTROL_CHARS_PATTERN =
  /[\x00-\x1F\x7F\u061C\u200E-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** 8+ contiguous digits after separator removal — phone-like PII. */
export const PHONE_LIKE_DIGIT_RUN = /\d{8,}/;

/**
 * Phone-separator characters removed before digit-run detection in calendar
 * summary sanitization. Whitespace, parens, `.` `/` `-` `+`, and zero-width
 * chars (U+200B..U+200F, U+2060).
 *
 * Note: This intentionally does NOT include backslash (`\`), matching the
 * original calendar-sync.ts semantics. The pii-normalize.ts `PHONE_SEPARATORS`
 * constant (used by redactPhonesInString) additionally strips `\` because
 * Cloudflare Logs and Sentry payloads may contain escaped paths. Calendar
 * summary input (customer display_name) never contains literal backslashes
 * in phone separators, so the two pattern sets are functionally equivalent
 * for their respective callers.
 */
export const CALENDAR_PHONE_SEPARATOR_PATTERN = /[\s()./\-+​-‏⁠]/g;

/**
 * Date-like patterns: `YYYY-MM-DD` / `YYYY/MM/DD` / `YYYY.MM.DD` and
 * Japanese `YYYY年M月D日`.
 */
export const DATE_ANY_PATTERN = /\d{4}([/.-]|年)\d{1,2}([/.-]|月)\d{1,2}日?/;

/**
 * Sanitize a customer display_name for Google Calendar event summary.
 *
 * Phone-like / date-like / email-like / control-char content is stripped to
 * prevent PII leakage into the Calendar summary (SPEC.md invariant L872).
 * When PII is detected the generic fallback "ご予約" is returned.
 * The DB-side value is never modified.
 *
 * @param raw `customers.display_name` — may be null.
 */
export const sanitizeCustomerNameForCalendarSummary = (raw: string | null): string => {
  if (!raw) return "氏名未登録";
  // 表示用は元の文字を保つ (全角名前は全角のまま)、PII 判定だけ ASCII に寄せる。
  const display = raw.replace(CONTROL_CHARS_PATTERN, "").trim();
  if (!display) return "氏名未登録";
  const probe = normalizeForPii(display);
  // 1) email-like → 確定的に PII
  if (EMAIL_LIKE_PATTERN.test(probe)) return "ご予約";
  // 2) date-like (ASCII / 全角 / 年月日) → 生年月日扱い
  if (DATE_ANY_PATTERN.test(probe)) return "ご予約";
  // 3) phone-like: separator (空白 / 括弧 / `.` `/` `-` `+` / ゼロ幅) を除去後、
  //    8 桁以上の連続数字があれば phone 扱い。括弧区切り (`090(1234)5678`) や
  //    スラッシュ区切り (`075/123/4567`) を捕捉する。
  const stripped = probe.replace(CALENDAR_PHONE_SEPARATOR_PATTERN, "");
  if (PHONE_LIKE_DIGIT_RUN.test(stripped)) return "ご予約";
  return display;
};
