/**
 * Tests for the outbound fetch timeout wrapper used on cron/queue paths.
 *
 * The wrapper attaches an AbortSignal.timeout signal to any request that
 * does not already carry a caller-supplied signal. The signal deliberately
 * stays armed THROUGH response body reads (an upstream that stalls while
 * streaming the body must abort too), so these tests use REAL timers with
 * tiny timeouts — AbortSignal.timeout's internal timer is not driven by
 * vitest fake timers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyD1SweepFailure,
  DEFAULT_OUTBOUND_TIMEOUT_MS,
  isRetryableD1Error,
  isTransientD1Error,
  withOutboundTimeout
} from "../src/outbound-timeout";

/**
 * A fake fetcher that resolves immediately and records the (input, init) it
 * was called with so tests can assert what the wrapper injected.
 */
const makeRecordingFetcher = () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response("ok");
  }) as unknown as typeof fetch;
  return { fetcher, calls };
};

/**
 * A fake fetcher that NEVER resolves on its own — it only rejects when the
 * injected signal aborts. (An AbortSignal does not reject a pending promise
 * by itself; the fetch implementation must observe the abort — plan A1.)
 */
const makeAbortAwareHangingFetcher = () => {
  const fetcher = vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (!signal) {
          return; // hang forever
        }
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true }
        );
      })
  ) as unknown as typeof fetch;
  return { fetcher };
};

describe("withOutboundTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("injects a timeout signal when the caller did not supply one", async () => {
    const { fetcher, calls } = makeRecordingFetcher();
    const wrapped = withOutboundTimeout(fetcher);

    await wrapped("https://example.com/api");

    expect(calls).toHaveLength(1);
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].init?.signal?.aborted).toBe(false);
  });

  it("preserves existing init fields while injecting the signal", async () => {
    const { fetcher, calls } = makeRecordingFetcher();
    const wrapped = withOutboundTimeout(fetcher);

    await wrapped("https://example.com/api", {
      method: "POST",
      headers: { Authorization: "Bearer x" },
      body: '{"a":1}'
    });

    const init = calls[0].init;
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ Authorization: "Bearer x" });
    expect(init?.body).toBe('{"a":1}');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("passes through untouched when the caller supplies its own signal", async () => {
    const { fetcher, calls } = makeRecordingFetcher();
    const wrapped = withOutboundTimeout(fetcher);
    const controller = new AbortController();

    await wrapped("https://example.com/api", { signal: controller.signal });

    // The caller's own signal is preserved — no new timeout signal injected.
    expect(calls[0].init?.signal).toBe(controller.signal);
  });

  it("aborts with a TimeoutError after the timeout elapses", async () => {
    // Real timers: AbortSignal.timeout is not driven by vitest fake timers.
    const { fetcher } = makeAbortAwareHangingFetcher();
    const wrapped = withOutboundTimeout(fetcher, 20);

    await expect(wrapped("https://example.com/slow")).rejects.toMatchObject({
      name: "TimeoutError"
    });
  });

  it("keeps the signal armed after the fetch resolves (covers body-read stalls)", async () => {
    // An upstream can send headers (fetch resolves) and then stall while
    // streaming the body. The timeout signal must still fire so a hung
    // response.json() is aborted too — this is why the wrapper does NOT
    // clear the timeout when fetch settles.
    const { fetcher, calls } = makeRecordingFetcher();
    const wrapped = withOutboundTimeout(fetcher, 20);

    await wrapped("https://example.com/fast");
    const signal = calls[0].init?.signal;
    expect(signal?.aborted).toBe(false);

    await new Promise((r) => setTimeout(r, 40));
    expect(signal?.aborted).toBe(true);
    expect((signal?.reason as DOMException)?.name).toBe("TimeoutError");
  });

  it("exposes a 30s default timeout", () => {
    expect(DEFAULT_OUTBOUND_TIMEOUT_MS).toBe(30_000);
  });
});

describe("isTransientD1Error", () => {
  it("matches the D1 long-running-export error (D1_ERROR-prefixed)", () => {
    expect(
      isTransientD1Error(new Error("D1_ERROR: Currently processing a long-running export."))
    ).toBe(true);
  });

  it("matches the raw message variant (chained 'during handling' throw)", () => {
    expect(isTransientD1Error(new Error("Currently processing a long-running export."))).toBe(true);
  });

  it("matches a non-Error throw carrying the message", () => {
    expect(isTransientD1Error("Currently processing a long-running export")).toBe(true);
  });

  it("matches a plain { message } object (serialized / rethrown error)", () => {
    // A bare object stringifies to "[object Object]" — the classifier must read
    // its `message` field instead so a wrapped D1 error is not missed.
    expect(isTransientD1Error({ message: "D1_ERROR: Currently processing a long-running export." })).toBe(
      true
    );
    expect(isTransientD1Error({ message: "some other failure" })).toBe(false);
  });

  it("does NOT swallow genuine D1 errors (they must still surface)", () => {
    expect(isTransientD1Error(new Error("D1_ERROR: no such table: google_calendar_import_jobs"))).toBe(
      false
    );
    expect(isTransientD1Error(new Error("UNIQUE constraint failed"))).toBe(false);
    expect(isTransientD1Error(new Error("network error"))).toBe(false);
  });

  it("does NOT match a transient abort (that is isTransientAbortError's domain)", () => {
    expect(isTransientD1Error({ name: "TimeoutError" })).toBe(false);
  });
});

describe("isRetryableD1Error", () => {
  it.each([
    "D1_ERROR: internal error; reference = x",
    "D1_ERROR: Network connection lost.",
    "D1_ERROR: Internal error in D1 DB storage caused object to be reset.",
    "D1_ERROR: Internal error while starting up D1 DB storage caused object to be reset.",
    "D1_ERROR: D1 DB reset because its code was updated."
  ])("matches a retryable D1 infrastructure failure: %s", (message) => {
    expect(isRetryableD1Error(new Error(message))).toBe(true);
  });

  it("keeps the existing export-lock error retryable", () => {
    expect(
      isRetryableD1Error(new Error("D1_ERROR: Currently processing a long-running export."))
    ).toBe(true);
  });

  it("reads a plain { message } object and ignores message casing", () => {
    expect(
      isRetryableD1Error({ message: "D1_ERROR: INTERNAL ERROR; REFERENCE = serialized" })
    ).toBe(true);
  });

  it.each([
    "UNIQUE constraint failed: reservations.id",
    "D1_ERROR: no such table: reservations",
    // Cloudflare の対処は「クエリ最適化・分割」であって retry ではないため、
    // soft-skip すると恒久的な性能不具合が cron monitor / 500 契約から消える。
    "D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.",
    // アプリ由来の "internal error" は D1_ERROR prefix も reference id も伴わない。
    "application internal error while building statements",
    "internal error",
    // reference を騙っても D1_ERROR が無ければ D1 の一過性障害ではない。
    "application internal error while building statements; reference = local",
    // reference id が空 = 観測形式ではない。
    "D1_ERROR: internal error; reference ="
  ])("does not classify a permanent failure as retryable: %s", (message) => {
    expect(isRetryableD1Error(new Error(message))).toBe(false);
    // sweep 側の分類も write_failed のまま (= throw / 500 契約を維持) であること。
    expect(classifyD1SweepFailure(new Error(message))).toBe("write_failed");
  });

  it("does not broaden the export-lock-only telemetry suppression classifier", () => {
    expect(isTransientD1Error(new Error("D1_ERROR: internal error; reference = x"))).toBe(false);
  });
});
