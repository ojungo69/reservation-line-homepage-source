import { withOutboundTimeout } from "../outbound-timeout";

type LineIdTokenPayload = {
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  nonce?: string;
  name?: string;
  picture?: string;
  email?: string;
};

export type LineIdTokenResult =
  | {
      ok: true;
      payload: LineIdTokenPayload;
    }
  | {
      ok: false;
      reason:
        | "missing_id_token"
        | "invalid_id_token_input"
        | "line_verify_failed"
        | "invalid_line_id_token"
        | "invalid_line_audience"
        | "invalid_line_nonce"
        | "line_id_token_expired";
    };

export type LineFriendshipResult =
  | {
      ok: true;
      friendFlag: boolean;
    }
  | {
      ok: false;
      reason: "missing_line_access_token" | "line_friendship_failed" | "invalid_line_friendship_response";
    };

export type LineAccessTokenUserResult =
  | {
      ok: true;
      lineUserId: string;
    }
  | {
      ok: false;
      reason:
        | "missing_line_access_token"
        | "line_profile_failed"
        | "invalid_line_profile_response"
        | "line_user_mismatch";
    };

const LINE_VERIFY_ENDPOINT = "https://api.line.me/oauth2/v2.1/verify";
const LINE_FRIENDSHIP_ENDPOINT = "https://api.line.me/friendship/v1/status";
const LINE_PROFILE_ENDPOINT = "https://api.line.me/v2/profile";

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const isNonEmptyString = (value: unknown, maxLength: number): value is string => {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
};

const readJsonPayload = async (response: Response) => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

export async function verifyLineIdToken(
  input: {
    idToken: string;
    channelId: string;
    nonce?: string;
  },
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now
): Promise<LineIdTokenResult> {
  if (!input.idToken) {
    return {
      ok: false,
      reason: "missing_id_token"
    };
  }

  if (
    !isNonEmptyString(input.idToken, 8192) ||
    !isNonEmptyString(input.channelId, 128) ||
    (input.nonce !== undefined && input.nonce !== "" && !isNonEmptyString(input.nonce, 256))
  ) {
    return {
      ok: false,
      reason: "invalid_id_token_input"
    };
  }

  const body = new URLSearchParams({
    id_token: input.idToken,
    client_id: input.channelId
  });
  if (input.nonce) {
    body.set("nonce", input.nonce);
  }

  let response: Response;
  try {
    response = await withOutboundTimeout(fetcher, 5_000)(LINE_VERIFY_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });
  } catch {
    return {
      ok: false,
      reason: "line_verify_failed"
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: "line_verify_failed"
    };
  }

  const payload = await readJsonPayload(response);
  if (
    !isObject(payload) ||
    !isNonEmptyString(payload.sub, 128) ||
    !isNonEmptyString(payload.aud, 128) ||
    typeof payload.exp !== "number" ||
    typeof payload.iat !== "number"
  ) {
    return {
      ok: false,
      reason: "invalid_line_id_token"
    };
  }

  if (payload.aud !== input.channelId) {
    return {
      ok: false,
      reason: "invalid_line_audience"
    };
  }

  if (input.nonce && payload.nonce !== input.nonce) {
    return {
      ok: false,
      reason: "invalid_line_nonce"
    };
  }

  if (payload.exp * 1000 <= now()) {
    return {
      ok: false,
      reason: "line_id_token_expired"
    };
  }

  return {
    ok: true,
    payload: {
      sub: payload.sub,
      aud: payload.aud,
      exp: payload.exp,
      iat: payload.iat,
      nonce: typeof payload.nonce === "string" ? payload.nonce : undefined,
      name: typeof payload.name === "string" ? payload.name : undefined,
      picture: typeof payload.picture === "string" ? payload.picture : undefined,
      email: typeof payload.email === "string" ? payload.email : undefined
    }
  };
}

export async function verifyLineAccessTokenUser(
  accessToken: string,
  expectedLineUserId: string,
  fetcher: typeof fetch = fetch
): Promise<LineAccessTokenUserResult> {
  if (!isNonEmptyString(accessToken, 4096)) {
    return {
      ok: false,
      reason: "missing_line_access_token"
    };
  }

  if (!isNonEmptyString(expectedLineUserId, 128)) {
    return {
      ok: false,
      reason: "invalid_line_profile_response"
    };
  }

  let response: Response;
  try {
    response = await withOutboundTimeout(fetcher, 5_000)(LINE_PROFILE_ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
  } catch {
    return {
      ok: false,
      reason: "line_profile_failed"
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: "line_profile_failed"
    };
  }

  const payload = await readJsonPayload(response);
  if (!isObject(payload) || !isNonEmptyString(payload.userId, 128)) {
    return {
      ok: false,
      reason: "invalid_line_profile_response"
    };
  }

  if (payload.userId !== expectedLineUserId) {
    return {
      ok: false,
      reason: "line_user_mismatch"
    };
  }

  return {
    ok: true,
    lineUserId: payload.userId
  };
}

export async function verifyLineFriendship(
  accessToken: string,
  fetcher: typeof fetch = fetch
): Promise<LineFriendshipResult> {
  if (!isNonEmptyString(accessToken, 4096)) {
    return {
      ok: false,
      reason: "missing_line_access_token"
    };
  }

  let response: Response;
  try {
    response = await withOutboundTimeout(fetcher, 5_000)(LINE_FRIENDSHIP_ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
  } catch {
    return {
      ok: false,
      reason: "line_friendship_failed"
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: "line_friendship_failed"
    };
  }

  const payload = await readJsonPayload(response);
  if (!isObject(payload) || typeof payload.friendFlag !== "boolean") {
    return {
      ok: false,
      reason: "invalid_line_friendship_response"
    };
  }

  return {
    ok: true,
    friendFlag: payload.friendFlag
  };
}
