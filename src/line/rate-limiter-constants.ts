// ── Token-bucket constants & types ──────────────────────────────────
// Extracted from rate-limiter-do.ts so unit tests running in Node.js
// can import them without pulling in the `cloudflare:workers` module.

/** LINE Messaging API: 2000 requests / 60 000 ms. */
export const BUCKET_CAPACITY = 50;

/** ~0.0333 tokens/ms (2000 / 60_000). */
export const RATE_PER_MS = 2000 / 60_000;

export type AcquireResult =
  | { ok: true }
  | { ok: false; retryAfterMs: number };
