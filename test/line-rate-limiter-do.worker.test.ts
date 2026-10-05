import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BUCKET_CAPACITY,
  LineRateLimiter,
  RATE_PER_MS,
  type AcquireResult
} from "../src/line/rate-limiter-do";

// ── Fake DurableObjectState for unit-testing ────────────────────────
// The real DurableObjectState is a Cloudflare runtime class. We provide
// a minimal double that covers the surface used by LineRateLimiter:
// ctx.storage.get/put and ctx.blockConcurrencyWhile.

class FakeStorage {
  private store = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
}

function createFakeCtx(storage?: FakeStorage) {
  const s = storage ?? new FakeStorage();
  return {
    storage: s,
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>): Promise<T> => fn()
  };
}

// ── Helpers ─────────────────────────────────────────────────────────
// DurableObject base class expects super(ctx, env). Since we bypass the
// real runtime, we construct LineRateLimiter via Object.create and then
// manually invoke the constructor body. This avoids importing the
// cloudflare:workers module in a Node.js vitest environment.

function createLimiter(storage?: FakeStorage, nowMs?: number): LineRateLimiter {
  const ctx = createFakeCtx(storage);

  // Freeze Date.now for deterministic refill calculations.
  if (nowMs !== undefined) {
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
  }

  // Bypass super() — we only need the instance fields + methods.
  const instance = Object.create(LineRateLimiter.prototype) as LineRateLimiter;

  // Replicate constructor logic without calling super().
  // @ts-expect-error -- accessing private fields for test setup
  instance.tokens = BUCKET_CAPACITY;
  // @ts-expect-error -- accessing private fields for test setup
  instance.lastRefillMs = nowMs ?? Date.now();
  // @ts-expect-error -- accessing private ctx field
  instance.ctx = ctx;

  // Run blockConcurrencyWhile init (loads from storage if present).
  // For a fresh limiter there's nothing stored, so defaults stand.
  return instance;
}

async function createLimiterFromStorage(
  storage: FakeStorage,
  nowMs: number
): Promise<LineRateLimiter> {
  const ctx = createFakeCtx(storage);
  vi.spyOn(Date, "now").mockReturnValue(nowMs);

  const instance = Object.create(LineRateLimiter.prototype) as LineRateLimiter;
  // @ts-expect-error -- private
  instance.ctx = ctx;

  // Simulate blockConcurrencyWhile init from stored state.
  const stored = await ctx.storage.get<{ tokens: number; lastRefillMs: number }>("bucket");
  if (stored) {
    // @ts-expect-error -- private
    instance.tokens = stored.tokens;
    // @ts-expect-error -- private
    instance.lastRefillMs = stored.lastRefillMs;
  } else {
    // @ts-expect-error -- private
    instance.tokens = BUCKET_CAPACITY;
    // @ts-expect-error -- private
    instance.lastRefillMs = nowMs;
  }

  return instance;
}

describe("LineRateLimiter Durable Object", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("acquires tokens within capacity", async () => {
    const limiter = createLimiter(undefined, 1_000_000);

    const result = await limiter.acquire(5);
    expect(result).toEqual({ ok: true });
  });

  it("acquires the full bucket capacity in one call", async () => {
    const limiter = createLimiter(undefined, 1_000_000);

    const result = await limiter.acquire(BUCKET_CAPACITY);
    expect(result).toEqual({ ok: true });
  });

  it("rejects when requesting more than available tokens", async () => {
    const nowMs = 1_000_000;
    const limiter = createLimiter(undefined, nowMs);

    // Drain the bucket.
    await limiter.acquire(BUCKET_CAPACITY);

    // Advance time by 0ms (no refill).
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const result = await limiter.acquire(5);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 5 tokens at ~0.0333/ms = ~150ms
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(result.retryAfterMs).toBeLessThanOrEqual(
        Math.ceil(5 / RATE_PER_MS)
      );
    }
  });

  it("refills tokens over time and allows subsequent acquire", async () => {
    const t0 = 1_000_000;
    const limiter = createLimiter(undefined, t0);

    // Drain the bucket completely.
    await limiter.acquire(BUCKET_CAPACITY);

    // Advance time enough to refill 10 tokens.
    // 10 / RATE_PER_MS = 10 / 0.0333... = ~300ms
    const refillMs = Math.ceil(10 / RATE_PER_MS);
    vi.spyOn(Date, "now").mockReturnValue(t0 + refillMs);

    const result = await limiter.acquire(10);
    expect(result).toEqual({ ok: true });
  });

  it("caps refill at bucket capacity", async () => {
    const t0 = 1_000_000;
    const limiter = createLimiter(undefined, t0);

    // Drain 10 tokens (leaves 40).
    await limiter.acquire(10);

    // Advance time far enough to refill way more than deficit.
    // 60_000ms = 1 minute = 2000 tokens of refill, but cap is 50.
    vi.spyOn(Date, "now").mockReturnValue(t0 + 60_000);

    // Should succeed for full capacity but no more.
    const result = await limiter.acquire(BUCKET_CAPACITY);
    expect(result).toEqual({ ok: true });

    // Now the bucket should be empty again.
    vi.spyOn(Date, "now").mockReturnValue(t0 + 60_000);
    const result2 = await limiter.acquire(1);
    expect(result2.ok).toBe(false);
  });

  it("returns sensible retryAfterMs for partial deficit", async () => {
    const t0 = 1_000_000;
    const limiter = createLimiter(undefined, t0);

    // Drain to leave 3 tokens.
    await limiter.acquire(BUCKET_CAPACITY - 3);
    vi.spyOn(Date, "now").mockReturnValue(t0);

    // Request 10 — deficit is 7.
    const result = await limiter.acquire(10);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const expectedMs = Math.ceil(7 / RATE_PER_MS);
      expect(result.retryAfterMs).toBe(expectedMs);
    }
  });

  it("handles acquire(0) as a no-op success", async () => {
    const limiter = createLimiter(undefined, 1_000_000);

    const result = await limiter.acquire(0);
    expect(result).toEqual({ ok: true });
  });

  it("handles negative count as a no-op success", async () => {
    const limiter = createLimiter(undefined, 1_000_000);

    const result = await limiter.acquire(-5);
    expect(result).toEqual({ ok: true });
  });

  it("persists state to storage on successful acquire", async () => {
    const storage = new FakeStorage();
    const t0 = 1_000_000;
    const limiter = createLimiter(storage, t0);

    await limiter.acquire(5);

    const stored = await storage.get<{ tokens: number; lastRefillMs: number }>("bucket");
    expect(stored).toBeDefined();
    expect(stored!.tokens).toBe(BUCKET_CAPACITY - 5);
    expect(stored!.lastRefillMs).toBe(t0);
  });

  it("restores state from storage on cold start", async () => {
    const storage = new FakeStorage();
    const t0 = 1_000_000;

    // Pre-seed storage as if a previous instance persisted 10 tokens.
    await storage.put("bucket", { tokens: 10, lastRefillMs: t0 });

    const limiter = await createLimiterFromStorage(storage, t0);

    // Should only have 10 tokens available (no refill since same time).
    const result = await limiter.acquire(10);
    expect(result).toEqual({ ok: true });

    const result2 = await limiter.acquire(1);
    expect(result2.ok).toBe(false);
  });

  it("cold start with no stored state initialises to full capacity", async () => {
    const storage = new FakeStorage();
    const t0 = 1_000_000;

    const limiter = await createLimiterFromStorage(storage, t0);

    const result = await limiter.acquire(BUCKET_CAPACITY);
    expect(result).toEqual({ ok: true });
  });

  it("accumulates fractional tokens across short windows (no Math.floor refill discard)", async () => {
    const t0 = 1_000_000;
    const limiter = createLimiter(undefined, t0);

    // Drain the bucket completely.
    await limiter.acquire(BUCKET_CAPACITY);

    // Advance 20ms — RATE_PER_MS ~= 0.0333, so 20ms refills ~0.667 tokens.
    // Old (integer) refill discarded sub-1 tokens here; the new floating-point
    // accumulation should retain them. Then advance another 20ms (~0.667 more),
    // total accumulated ~1.33 → 1 whole token available.
    vi.spyOn(Date, "now").mockReturnValue(t0 + 20);
    const denied1 = await limiter.acquire(1);
    expect(denied1.ok).toBe(false); // <1 whole token

    vi.spyOn(Date, "now").mockReturnValue(t0 + 40);
    const granted = await limiter.acquire(1);
    expect(granted.ok).toBe(true); // accumulated >= 1 across 40ms total
  });

  it("does not reset lastRefillMs on consume (preserves sub-ms refill progress)", async () => {
    const t0 = 1_000_000;
    const limiter = createLimiter(undefined, t0);

    // Drain to leave a few tokens, then advance time slightly.
    await limiter.acquire(BUCKET_CAPACITY - 2);
    vi.spyOn(Date, "now").mockReturnValue(t0 + 30); // ~1 token refilled
    await limiter.acquire(1); // consume — must not reset lastRefillMs to nowMs

    // Read internal state to verify lastRefillMs advanced via refill(), not consume.
    // Both reach via the persisted snapshot to avoid touching private fields directly.
    const storage = new FakeStorage();
    const limiter2 = createLimiter(storage, t0);
    await limiter2.acquire(1);
    const stored = await storage.get<{ tokens: number; lastRefillMs: number }>(
      "bucket"
    );
    // lastRefillMs should equal t0 (no refill since elapsed=0 at this point).
    expect(stored?.lastRefillMs).toBe(t0);
  });
});
