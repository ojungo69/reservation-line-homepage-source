const BASE_RETRY_DELAY_MS = 60 * 1000;
const MAX_RETRY_DELAY_MS = 30 * 60 * 1000;
const JITTER_WINDOW_MS = 60 * 1000;
const MAX_EXPONENT = 5;

const stableJitterMs = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + (value.codePointAt(index) ?? 0)) >>> 0;
  }
  return hash % JITTER_WINDOW_MS;
};

export const calculateGoogleRetryDelayMs = (attemptNumber: number, jitterKey: string) => {
  const normalizedAttempt = Number.isFinite(attemptNumber) ? Math.trunc(attemptNumber) : 1;
  const boundedAttempt = Math.max(1, normalizedAttempt);
  const exponent = Math.min(boundedAttempt - 1, MAX_EXPONENT);
  const baseDelay = Math.min(BASE_RETRY_DELAY_MS * 2 ** exponent, MAX_RETRY_DELAY_MS);
  return Math.min(baseDelay + stableJitterMs(`${jitterKey}:${boundedAttempt}`), MAX_RETRY_DELAY_MS);
};
