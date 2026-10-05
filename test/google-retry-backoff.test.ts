import { describe, expect, it } from "vitest";

import { calculateGoogleRetryDelayMs } from "../src/google/retry-backoff";

describe("Google retry backoff", () => {
  it("uses bounded exponential backoff with deterministic jitter", () => {
    const key = "google_retry_backoff_job_1";

    const first = calculateGoogleRetryDelayMs(1, key);
    const second = calculateGoogleRetryDelayMs(2, key);

    expect(first).toBeGreaterThanOrEqual(60_000);
    expect(first).toBeLessThan(2 * 60_000);
    expect(second).toBeGreaterThanOrEqual(2 * 60_000);
    expect(second).toBeLessThan(3 * 60_000);
    expect(calculateGoogleRetryDelayMs(3, key)).toBe(calculateGoogleRetryDelayMs(3, key));
    expect(calculateGoogleRetryDelayMs(99, key)).toBe(30 * 60_000);
  });

  it("treats non-finite attempts as the first retry window", () => {
    const delay = calculateGoogleRetryDelayMs(Number.NaN, "google_retry_backoff_job_2");

    expect(delay).toBeGreaterThanOrEqual(60_000);
    expect(delay).toBeLessThan(2 * 60_000);
  });
});
