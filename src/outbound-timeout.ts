/**
 * Outbound fetch timeout wrapper.
 *
 * cron/queue handlers call Google / LINE over bare `fetch` with no
 * AbortSignal. When an upstream stalls, the request stays pending forever,
 * so the cron's Promise.allSettled never settles and the invocation is held
 * by Sentry.withMonitor + ctx.waitUntil up to the 15-minute wall limit
 * (observed as intermittent exceededCpu kills on the 10-minute cron).
 *
 * This wrapper attaches a timeout signal to every request that does not
 * already carry a caller-supplied signal, so any hung outbound request is
 * released after `timeoutMs`.
 */
export const DEFAULT_OUTBOUND_TIMEOUT_MS = 30_000;

/**
 * True when `err` is the abort thrown by an outbound timeout — `AbortSignal.timeout`
 * rejects with a `DOMException` named "TimeoutError", and a caller-cancelled
 * `AbortController` rejects with name "AbortError". Both are TRANSIENT upstream stalls
 * outside our control: the caller degrades gracefully (e.g. retries on the next sweep),
 * so they are not worth a Sentry exception. Genuine failures (network TypeError, HTTP
 * errors, parse errors) are NOT classified here and stay captured. Mirrors the
 * name-based half of `isTransientQuotaFetchError` (src/line/quota.ts).
 */
export const isTransientAbortError = (err: unknown): boolean => {
  const name = typeof err === "object" && err !== null && "name" in err ? String(err.name) : "";
  return name === "TimeoutError" || name === "AbortError";
};

/**
 * True when `err` is the transient D1 error raised while a long-running D1 export
 * is in progress (Cloudflare backup / Time Travel export — e.g. the
 * `backup-verify` workflow's `wrangler d1 export`): for the export's duration D1
 * rejects EVERY write on that database with "Currently processing a long-running
 * export." It clears on its own within seconds, so a claim-based cron sweep just
 * retries on its next 10-minute tick — not a code fault and not worth a Sentry
 * exception. Substring match tolerates the `D1_ERROR:` prefix the D1 client wraps
 * around the underlying message. Sibling of `isTransientAbortError`: both decide
 * soft-fail-and-retry vs. capture.
 */
export const isTransientD1Error = (err: unknown): boolean => {
  return readErrorMessage(err).includes("Currently processing a long-running export");
};

/**
 * Best-effort error message extraction that reads `message` off the ORIGINAL
 * throw without first wrapping it in `new Error()`. A plain `{ message }` object
 * (a serialized / rethrown D1 error) would otherwise stringify to
 * "[object Object]" and slip past message-based classifiers. Mirrors the
 * "classify on the original throw" rule in isTransientQuotaFetchError
 * (src/line/quota.ts).
 */
export const readErrorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String(err.message);
  }
  return String(err);
};

// Cloudflare が「retry せよ」と明示している D1 インフラエラーだけを列挙する
// (docs の Error list: 対処が retry と書かれている行のみ)。sweep は冪等なので、
// これらは恒久的なアプリ不具合と分けて次回実行へ回せる。
// https://developers.cloudflare.com/d1/observability/debug-d1/
// https://developers.cloudflare.com/d1/best-practices/retry-queries/
//
// ⚠️ ここに文言を足すときは「Cloudflare が retry を案内しているか」を確認する。
// 例えば `storage operation exceeded timeout which caused object to be reset` は
// 「大量書き込みでクエリが遅すぎる」= クエリ最適化/分割が対処なので **含めない**
// (soft-skip すると恒久的な性能不具合が cron monitor と 500 契約から消える)。
const RETRYABLE_D1_ERROR_MESSAGES = [
  // "Internal error while starting up D1 DB storage caused object to be reset" /
  // "Internal error in D1 DB storage caused object to be reset" の両方を覆う
  "storage caused object to be reset",
  "Network connection lost",
  "reset because its code was updated"
] as const;

// D1 backend が返す `D1_ERROR: internal error; reference = <id>` 形式。docs の
// error list には無いが実際に本番で観測され (Sentry RESERVATION-LINE-HOMEPAGE-E)、
// 内容は D1 側の一過性障害。三要素すべて (D1 クライアントが付ける `D1_ERROR` /
// `internal error` / 非空の reference id) を要求する: `internal error` 単体や
// reference だけの部分一致にすると、sweep の catch が拾うアプリ由来の恒久エラー
// (例 "application internal error while building statements; reference = local")
// まで soft-skip され、write_failed の throw / 500 契約が失われる。行頭に固定
// しないのは、再 throw で prefix が付いた形 (`Error: D1_ERROR: ...`) も同じ
// 一過性障害だから (isTransientD1Error が部分一致なのと同じ理由)。
const D1_INTERNAL_ERROR_PATTERN = /D1_ERROR[^\n]*internal error[^\n]*reference\s*=\s*\S+/i;

export const isRetryableD1Error = (err: unknown): boolean => {
  if (isTransientD1Error(err)) return true;

  const message = readErrorMessage(err);
  if (D1_INTERNAL_ERROR_PATTERN.test(message)) return true;

  const normalized = message.toLowerCase();
  return RETRYABLE_D1_ERROR_MESSAGES.some((candidate) =>
    normalized.includes(candidate.toLowerCase())
  );
};

// export ロックだけは従来の専用 reason を保ち、それ以外の retryable エラーを
// Sentry RESERVATION-LINE-HOMEPAGE-E/F 用の transient_d1 として区別する。
export const classifyD1SweepFailure = (
  error: unknown
): "d1_export_locked" | "transient_d1" | "write_failed" => {
  if (isTransientD1Error(error)) return "d1_export_locked";
  if (isRetryableD1Error(error)) return "transient_d1";
  return "write_failed";
};

/**
 * Wrap a fetcher so outbound requests without a caller-supplied signal are
 * bounded by a timeout.
 *
 * Uses `AbortSignal.timeout` (not a manually-cleared AbortController):
 * the signal must stay armed through RESPONSE BODY reads, not just until
 * headers arrive — an upstream that sends headers and then stalls while
 * streaming the body would otherwise hang `response.json()` with no bound.
 * Clearing the timer when `fetcher(...)` resolves (the earlier design)
 * left exactly that gap. The 30s timer simply firing after a completed
 * request is a no-op abort and does not extend the invocation's lifetime.
 *
 * Requests that already carry their own `init.signal` are passed through
 * untouched so callers that manage their own cancellation are not altered.
 */
export const withOutboundTimeout = (
  fetcher: typeof fetch,
  timeoutMs: number = DEFAULT_OUTBOUND_TIMEOUT_MS
): typeof fetch => {
  return (input, init) => {
    if (init?.signal) {
      return fetcher(input, init);
    }
    return fetcher(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  };
};
