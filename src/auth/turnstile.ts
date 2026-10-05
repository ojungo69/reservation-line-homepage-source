import { withOutboundTimeout } from "../outbound-timeout";

export type TurnstileResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: "missing_turnstile_token" | "invalid_turnstile_token" | "turnstile_failed";
      errorCodes?: string[];
    };

const TURNSTILE_SITEVERIFY_ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const isNonEmptyString = (value: unknown, maxLength: number) => {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
};

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

export async function verifyTurnstileToken(
  input: {
    token: string | undefined;
    secret: string;
    remoteIp?: string;
    idempotencyKey?: string;
    expectedHostname?: string;
    expectedAction?: string;
  },
  fetcher: typeof fetch = fetch
): Promise<TurnstileResult> {
  if (!input.token) {
    return {
      ok: false,
      reason: "missing_turnstile_token"
    };
  }

  if (!isNonEmptyString(input.token, 2048) || !isNonEmptyString(input.secret, 4096)) {
    return {
      ok: false,
      reason: "invalid_turnstile_token"
    };
  }

  const body: Record<string, string> = {
    secret: input.secret,
    response: input.token
  };
  if (input.idempotencyKey) {
    body.idempotency_key = input.idempotencyKey;
  }
  if (input.remoteIp) {
    body.remoteip = input.remoteIp;
  }

  let response: Response;
  try {
    response = await withOutboundTimeout(fetcher, 5_000)(TURNSTILE_SITEVERIFY_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
  } catch {
    return {
      ok: false,
      reason: "turnstile_failed",
      errorCodes: ["network-error"]
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: "turnstile_failed",
      errorCodes: [`http-${response.status}`]
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      reason: "turnstile_failed",
      errorCodes: ["invalid-json"]
    };
  }

  if (!isObject(payload) || payload.success !== true) {
    const errorCodes = isObject(payload) && Array.isArray(payload["error-codes"])
      ? payload["error-codes"].filter((code): code is string => typeof code === "string")
      : undefined;

    return {
      ok: false,
      reason: "turnstile_failed",
      errorCodes
    };
  }

  if (input.expectedHostname && payload.hostname !== input.expectedHostname) {
    return {
      ok: false,
      reason: "turnstile_failed",
      errorCodes: ["hostname-mismatch"]
    };
  }

  if (input.expectedAction && payload.action !== input.expectedAction) {
    return {
      ok: false,
      reason: "turnstile_failed",
      errorCodes: ["action-mismatch"]
    };
  }

  return {
    ok: true
  };
}
