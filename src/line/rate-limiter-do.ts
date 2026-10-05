import { DurableObject } from "cloudflare:workers";

import { BUCKET_CAPACITY, RATE_PER_MS, type AcquireResult } from "./rate-limiter-constants";

export type { AcquireResult } from "./rate-limiter-constants";
export { BUCKET_CAPACITY, RATE_PER_MS } from "./rate-limiter-constants";

/**
 * Distributed token-bucket rate limiter for LINE Messaging API calls.
 *
 * All call-sites (scheduled crons + queue consumer) resolve the same
 * singleton instance via `idFromName("LINE_RATE_LIMITER")` so the
 * budget is shared across concurrent handler invocations.
 *
 * Uses SQLite-backed Durable Object storage (`new_sqlite_classes`) for
 * free-plan compatibility. In-memory state is the hot path; storage is
 * written on every mutation so a DO eviction + cold restart resumes
 * with the correct token count.
 */
export class LineRateLimiter extends DurableObject<Record<string, unknown>> {
  // Tokens are tracked as a floating-point number so partial refill
  // progress is not discarded between acquire() calls (fractional
  // tokens accumulate across small elapsedMs windows). lastRefillMs is
  // only advanced inside refill(); consume() must NOT touch it,
  // otherwise the sub-millisecond progress between the most recent
  // refill and consume would be lost on every acquire.
  private tokens: number = BUCKET_CAPACITY;
  private lastRefillMs: number = Date.now();

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);

    // Restore persisted state on cold start. blockConcurrencyWhile
    // prevents any RPC call from executing until init completes.
    // Cloudflare resets the object if this callback rejects.
    void ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<{ tokens: number; lastRefillMs: number }>(
        "bucket"
      );
      if (stored) {
        this.tokens = stored.tokens;
        this.lastRefillMs = stored.lastRefillMs;
      }
      // If nothing is stored (first deploy), defaults are already set
      // to full capacity + current time.
    });
  }

  /**
   * Attempt to acquire `count` tokens from the bucket.
   *
   * The refill + deduct is a synchronous flow -- Durable Objects are
   * single-threaded so no additional locking is needed.
   */
  async acquire(count: number): Promise<AcquireResult> {
    if (count <= 0) {
      return { ok: true };
    }

    const nowMs = Date.now();
    this.refill(nowMs);

    // `count` is integer-typed by callers; compare against the floor
    // of fractional tokens so we never grant more whole tokens than
    // are actually accumulated.
    if (Math.floor(this.tokens) >= count) {
      this.tokens -= count;
      await this.persist();
      return { ok: true };
    }

    // Insufficient tokens -- compute how long the caller should wait.
    const deficit = count - this.tokens;
    const retryAfterMs = Math.ceil(deficit / RATE_PER_MS);
    return { ok: false, retryAfterMs };
  }

  // ── internals ───────────────────────────────────────────────────────

  private refill(nowMs: number): void {
    const elapsedMs = nowMs - this.lastRefillMs;
    if (elapsedMs <= 0) {
      return;
    }
    // Floating-point accumulation: do NOT Math.floor here. Partial
    // tokens (e.g. 0.7) carry forward to the next refill so fast
    // back-to-back acquire() calls do not silently discard refill
    // progress.
    this.tokens = Math.min(this.tokens + elapsedMs * RATE_PER_MS, BUCKET_CAPACITY);
    this.lastRefillMs = nowMs;
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put("bucket", {
      tokens: this.tokens,
      lastRefillMs: this.lastRefillMs
    });
  }
}
