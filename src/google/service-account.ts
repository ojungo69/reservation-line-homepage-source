import { sha256Hex } from "../crypto-utils";
import { safeCaptureException } from "../sentry-helpers";

export type ServiceAccountTokenResult =
  | {
      ok: true;
      accessToken: string;
      expiresAt: number;
    }
  | {
      ok: false;
      reason: "invalid_service_account" | "token_request_failed" | "invalid_token_response";
    };

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_TOKEN_AUDIENCE = "https://oauth2.googleapis.com/token";
const JWT_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const TOKEN_EXPIRY_BUFFER_SECONDS = 300;

const textEncoder = new TextEncoder();

type CachedServiceAccountToken = {
  accessToken: string;
  expiresAt: number;
};

const serviceAccountTokenCaches = new WeakMap<typeof fetch, Map<string, CachedServiceAccountToken>>();

const isNonEmptyString = (value: unknown, maxLength: number): value is string => {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
};

const isValidServiceAccountInput = (input: {
  serviceAccountEmail: string;
  privateKey: string;
  scopes: string[];
}) => {
  return (
    isNonEmptyString(input.serviceAccountEmail, 320) &&
    isNonEmptyString(input.privateKey, 8192) &&
    input.scopes.length > 0 &&
    input.scopes.every((scope) => isNonEmptyString(scope, 256))
  );
};

const base64UrlEncodeBytes = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_");
  const padIndex = encoded.indexOf("=");
  return padIndex === -1 ? encoded : encoded.slice(0, padIndex);
};

const base64UrlEncodeJson = (value: unknown) => {
  return base64UrlEncodeBytes(textEncoder.encode(JSON.stringify(value)));
};

const tokenCacheForFetcher = (fetcher: typeof fetch) => {
  const existing = serviceAccountTokenCaches.get(fetcher);
  if (existing) {
    return existing;
  }
  const next = new Map<string, CachedServiceAccountToken>();
  serviceAccountTokenCaches.set(fetcher, next);
  return next;
};

const cacheKeyForServiceAccount = async (input: {
  serviceAccountEmail: string;
  privateKey: string;
  scopes: string[];
}) => {
  const privateKeyFingerprint = await sha256Hex(input.privateKey);
  return `${input.serviceAccountEmail}\u0000${input.scopes.join(" ")}\u0000${privateKeyFingerprint}`;
};

const pemToArrayBuffer = (pem: string) => {
  const normalizedPem = pem.replaceAll(String.raw`\n`, "\n");
  const base64 = normalizedPem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  if (!base64) {
    return undefined;
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }
  return bytes.buffer;
};

const createSignedJwt = async (input: {
  serviceAccountEmail: string;
  privateKey: string;
  scopes: string[];
  nowSeconds: number;
}) => {
  const privateKeyBytes = pemToArrayBuffer(input.privateKey);
  if (!privateKeyBytes) {
    return undefined;
  }

  const key = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyBytes,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const header = base64UrlEncodeJson({
    alg: "RS256",
    typ: "JWT"
  });
  const claimSet = base64UrlEncodeJson({
    iss: input.serviceAccountEmail,
    scope: input.scopes.join(" "),
    aud: GOOGLE_TOKEN_AUDIENCE,
    exp: input.nowSeconds + 3600,
    iat: input.nowSeconds
  });
  const unsignedToken = `${header}.${claimSet}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    textEncoder.encode(unsignedToken)
  );

  return `${unsignedToken}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
};

export async function createServiceAccountAccessToken(
  input: {
    serviceAccountEmail: string;
    privateKey: string;
    scopes: string[];
  },
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now
): Promise<ServiceAccountTokenResult> {
  if (!isValidServiceAccountInput(input)) {
    return {
      ok: false,
      reason: "invalid_service_account"
    };
  }

  let assertion: string | undefined;
  try {
    assertion = await createSignedJwt({
      serviceAccountEmail: input.serviceAccountEmail,
      privateKey: input.privateKey,
      scopes: input.scopes,
      nowSeconds: Math.floor(now() / 1000)
    });
  } catch {
    return {
      ok: false,
      reason: "invalid_service_account"
    };
  }

  if (!assertion) {
    return {
      ok: false,
      reason: "invalid_service_account"
    };
  }

  let response: Response;
  try {
    response = await fetcher(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: JWT_GRANT_TYPE,
        assertion
      })
    });
  } catch {
    return {
      ok: false,
      reason: "token_request_failed"
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: "token_request_failed"
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      reason: "invalid_token_response"
    };
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    !isNonEmptyString((payload as Record<string, unknown>).access_token, 4096) ||
    typeof (payload as Record<string, unknown>).expires_in !== "number"
  ) {
    return {
      ok: false,
      reason: "invalid_token_response"
    };
  }

  return {
    ok: true,
    accessToken: (payload as { access_token: string }).access_token,
    expiresAt: now() + (((payload as { expires_in: number }).expires_in - TOKEN_EXPIRY_BUFFER_SECONDS) * 1000)
  };
}

export async function getCachedServiceAccountAccessToken(
  input: {
    serviceAccountEmail: string;
    privateKey: string;
    scopes: string[];
  },
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now
): Promise<ServiceAccountTokenResult> {
  if (!isValidServiceAccountInput(input)) {
    return {
      ok: false,
      reason: "invalid_service_account"
    };
  }

  const cache = tokenCacheForFetcher(fetcher);
  const cacheKey = await cacheKeyForServiceAccount(input);
  const nowMs = now();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs) {
    return {
      ok: true,
      accessToken: cached.accessToken,
      expiresAt: cached.expiresAt
    };
  }

  const token = await createServiceAccountAccessToken(input, fetcher, now);
  if (token.ok && token.expiresAt > now()) {
    cache.set(cacheKey, {
      accessToken: token.accessToken,
      expiresAt: token.expiresAt
    });
  }
  return token;
}

const GOOGLE_CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";

// Failed tokens are never cached (only ok tokens are), so during an SA outage
// every claimed job re-fails and would re-capture — a 5-job cron tick emits 5
// near-identical Sentry events. Throttle to one capture per reason per isolate
// per interval; isolate recycling still refreshes the issue over a long outage.
const SA_FAILURE_CAPTURE_INTERVAL_MS = 10 * 60 * 1000;
const lastSaFailureCaptureAt = new Map<string, number>();

/** Minimal env shape the calendar access-token provider reads. */
interface CalendarAccessTokenEnv {
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: string;
}

/**
 * Resolve a Google Calendar access token (events scope) for the service account,
 * returning undefined when the token cannot be obtained. Shared by the channel-watch,
 * import-sync, and calendar-sync flows so the scope and token plumbing stay in one place.
 */
export const defaultGoogleCalendarAccessTokenProvider = async (
  env: CalendarAccessTokenEnv,
  fetcher: typeof fetch,
  now: () => number
): Promise<string | undefined> => {
  const token = await getCachedServiceAccountAccessToken(
    {
      serviceAccountEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      privateKey: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
      scopes: [GOOGLE_CALENDAR_EVENTS_SCOPE]
    },
    fetcher,
    now
  );
  if (!token.ok) {
    // Callers only see `undefined`, so record the typed failure reason here —
    // otherwise invalid_service_account (config broken) is indistinguishable
    // from token_request_failed (transient network) when diagnosing an outage.
    const nowMs = now();
    const lastCapturedAt = lastSaFailureCaptureAt.get(token.reason) ?? 0;
    if (nowMs - lastCapturedAt >= SA_FAILURE_CAPTURE_INTERVAL_MS) {
      lastSaFailureCaptureAt.set(token.reason, nowMs);
      safeCaptureException(new Error(`google_sa_token_failed: ${token.reason}`), {
        tags: { component: "google-service-account", reason: token.reason }
      });
    }
    return undefined;
  }
  return token.accessToken;
};
