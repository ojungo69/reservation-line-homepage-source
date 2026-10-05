import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkCustomerBlocked,
  evaluateReservationGate,
  enforceRateLimit,
  hashRateLimitKey,
  type ReservationGateRequest
} from "../src/auth/reservation-gate";
import { verifyLineAccessTokenUser, verifyLineFriendship, verifyLineIdToken } from "../src/auth/line";
import { verifyTurnstileToken } from "../src/auth/turnstile";
import { safeCaptureException } from "../src/sentry-helpers";
import { createMigratedSqliteD1 } from "./helpers/sqlite-d1";

vi.mock("../src/sentry-helpers", () => ({
  captureBatchWriteFailure: vi.fn(),
  safeCaptureException: vi.fn()
}));

import type { WorkerBindings } from "../src/bindings";

const baseEnv = {
  LINE_CHANNEL_ID: "line_channel_id",
  TURNSTILE_SECRET_KEY: "turnstile_secret"
} as WorkerBindings;

const okFetch = (json: unknown, status = 200) =>
  vi.fn(async () => Response.json(json, { status })) as unknown as typeof fetch;

describe("authentication HTTP deadlines", () => {
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  const verifications = [
    {
      name: "LINE ID token",
      verify: (fetcher: typeof fetch) => verifyLineIdToken({ idToken: "id_token_1", channelId: "line_channel_id" }, fetcher),
      headerFailure: { ok: false, reason: "line_verify_failed" },
      bodyFailure: { ok: false, reason: "invalid_line_id_token" }
    },
    {
      name: "LINE profile",
      verify: (fetcher: typeof fetch) => verifyLineAccessTokenUser("line_access_token", "line_user_1", fetcher),
      headerFailure: { ok: false, reason: "line_profile_failed" },
      bodyFailure: { ok: false, reason: "invalid_line_profile_response" }
    },
    {
      name: "LINE friendship",
      verify: (fetcher: typeof fetch) => verifyLineFriendship("line_access_token", fetcher),
      headerFailure: { ok: false, reason: "line_friendship_failed" },
      bodyFailure: { ok: false, reason: "invalid_line_friendship_response" }
    },
    {
      name: "Turnstile",
      verify: (fetcher: typeof fetch) => verifyTurnstileToken({ token: "turnstile_token", secret: "turnstile_secret" }, fetcher),
      headerFailure: { ok: false, reason: "turnstile_failed", errorCodes: ["network-error"] },
      bodyFailure: { ok: false, reason: "turnstile_failed", errorCodes: ["invalid-json"] }
    }
  ];

  beforeEach(() => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(20));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(verifications)("returns the existing $name failure when response headers stall", async ({ verify, headerFailure }) => {
    const fetcher = ((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;

    await expect(verify(fetcher)).resolves.toEqual(headerFailure);
  }, 1_000);

  it.each(verifications)("returns the existing $name failure when response body stalls", async ({ verify, bodyFailure }) => {
    const fetcher = (async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      }
    }))) as typeof fetch;

    await expect(verify(fetcher)).resolves.toEqual(bodyFailure);
  }, 1_000);
});

async function emptyD1Raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
async function emptyD1Raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
async function emptyD1Raw<T = unknown[]>(options?: { columnNames?: boolean }) {
  return options?.columnNames ? [[]] : [];
}

describe("LINE server-side verification", () => {
  it("posts the ID token to LINE verify endpoint with client_id and nonce", async () => {
    const fetchMock = okFetch({
      sub: "line_user_1",
      aud: "line_channel_id",
      exp: 1_800_000_000,
      iat: 1_700_000_000,
      nonce: "nonce_1",
      name: "Test User"
    });

    const result = await verifyLineIdToken(
      {
        idToken: "id_token_1",
        nonce: "nonce_1",
        channelId: "line_channel_id"
      },
      fetchMock
    );

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetchMock).mock.calls[0] ?? [];
    expect(url).toBe("https://api.line.me/oauth2/v2.1/verify");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded"
    });
    expect(String(init?.body)).toContain("id_token=id_token_1");
    expect(String(init?.body)).toContain("client_id=line_channel_id");
    expect(String(init?.body)).toContain("nonce=nonce_1");
  });

  it("omits nonce for LIFF tokens that were issued without an app-provided nonce", async () => {
    const fetchMock = okFetch({
      sub: "line_user_1",
      aud: "line_channel_id",
      exp: 1_800_000_000,
      iat: 1_700_000_000
    });

    const result = await verifyLineIdToken(
      {
        idToken: "id_token_1",
        channelId: "line_channel_id"
      },
      fetchMock
    );

    expect(result).toEqual({
      ok: true,
      payload: {
        sub: "line_user_1",
        aud: "line_channel_id",
        exp: 1_800_000_000,
        iat: 1_700_000_000,
        nonce: undefined,
        name: undefined,
        picture: undefined,
        email: undefined
      }
    });
    const [, init] = vi.mocked(fetchMock).mock.calls[0] ?? [];
    expect(String(init?.body)).toContain("id_token=id_token_1");
    expect(String(init?.body)).toContain("client_id=line_channel_id");
    expect(String(init?.body)).not.toContain("nonce=");
  });

  it("does not trust missing ID tokens or decoded payloads supplied by the client", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;

    const result = await verifyLineIdToken(
      {
        idToken: "",
        nonce: "nonce_1",
        channelId: "line_channel_id"
      },
      fetchMock
    );

    expect(result).toEqual({
      ok: false,
      reason: "missing_id_token"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects LINE ID tokens when client_id or nonce does not match", async () => {
    const audienceFetchMock = okFetch({
      sub: "line_user_1",
      aud: "other_channel",
      exp: 1_800_000_000,
      iat: 1_700_000_000,
      nonce: "nonce_1"
    });

    await expect(
      verifyLineIdToken(
        {
          idToken: "id_token_1",
          nonce: "nonce_1",
          channelId: "line_channel_id"
        },
        audienceFetchMock
      )
    ).resolves.toEqual({
      ok: false,
      reason: "invalid_line_audience"
    });

    const nonceFetchMock = okFetch({
      sub: "line_user_1",
      aud: "line_channel_id",
      exp: 1_800_000_000,
      iat: 1_700_000_000,
      nonce: "other_nonce"
    });

    await expect(
      verifyLineIdToken(
        {
          idToken: "id_token_1",
          nonce: "nonce_1",
          channelId: "line_channel_id"
        },
        nonceFetchMock
      )
    ).resolves.toEqual({
      ok: false,
      reason: "invalid_line_nonce"
    });
  });

  it("treats malformed LINE verification JSON as controlled auth failures", async () => {
    const badJsonFetch = vi.fn(async () => new Response("not-json", { status: 200 })) as unknown as typeof fetch;

    await expect(
      verifyLineIdToken(
        {
          idToken: "id_token_1",
          channelId: "line_channel_id"
        },
        badJsonFetch
      )
    ).resolves.toEqual({
      ok: false,
      reason: "invalid_line_id_token"
    });

    await expect(verifyLineAccessTokenUser("line_access_token", "line_user_1", badJsonFetch)).resolves.toEqual({
      ok: false,
      reason: "invalid_line_profile_response"
    });

    await expect(verifyLineFriendship("line_access_token", badJsonFetch)).resolves.toEqual({
      ok: false,
      reason: "invalid_line_friendship_response"
    });
  });

  it("checks friendship status with the LINE access token", async () => {
    const fetchMock = okFetch({
      friendFlag: true
    });

    const result = await verifyLineFriendship("line_access_token", fetchMock);

    expect(result).toEqual({
      ok: true,
      friendFlag: true
    });
    const [url, init] = vi.mocked(fetchMock).mock.calls[0] ?? [];
    expect(url).toBe("https://api.line.me/friendship/v1/status");
    expect(init?.headers).toEqual({
      Authorization: "Bearer line_access_token"
    });
  });

  it("checks that the LINE access token belongs to the verified ID token user", async () => {
    const fetchMock = okFetch({
      userId: "line_user_1",
      displayName: "Test User"
    });

    const result = await verifyLineAccessTokenUser("line_access_token", "line_user_1", fetchMock);

    expect(result).toEqual({
      ok: true,
      lineUserId: "line_user_1"
    });
    const [url, init] = vi.mocked(fetchMock).mock.calls[0] ?? [];
    expect(url).toBe("https://api.line.me/v2/profile");
    expect(init?.headers).toEqual({
      Authorization: "Bearer line_access_token"
    });
  });
});

describe("Turnstile verification", () => {
  it("validates submit tokens with Cloudflare Siteverify and an idempotency key", async () => {
    const fetchMock = okFetch({
      success: true,
      hostname: "reservation.test"
    });

    const result = await verifyTurnstileToken(
      {
        token: "turnstile_token",
        secret: "turnstile_secret",
        remoteIp: "203.0.113.10",
        idempotencyKey: "turnstile_idempotency"
      },
      fetchMock
    );

    expect(result).toEqual({
      ok: true
    });
    const [url, init] = vi.mocked(fetchMock).mock.calls[0] ?? [];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "Content-Type": "application/json"
    });
    await expect(new Response(init?.body).json()).resolves.toEqual({
      secret: "turnstile_secret",
      response: "turnstile_token",
      remoteip: "203.0.113.10",
      idempotency_key: "turnstile_idempotency"
    });
  });

  it("rejects oversized Turnstile tokens before calling Siteverify", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;

    const result = await verifyTurnstileToken(
      {
        token: "x".repeat(2049),
        secret: "turnstile_secret",
        idempotencyKey: "turnstile_idempotency"
      },
      fetchMock
    );

    expect(result).toEqual({
      ok: false,
      reason: "invalid_turnstile_token"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects Turnstile responses for the wrong hostname or action", async () => {
    const fetchMock = okFetch({
      success: true,
      hostname: "unexpected.test",
      action: "reservation-preview"
    });

    const result = await verifyTurnstileToken(
      {
        token: "turnstile_token",
        secret: "turnstile_secret",
        expectedHostname: "reservation.test",
        expectedAction: "reservation-submit"
      },
      fetchMock
    );

    expect(result).toEqual({
      ok: false,
      reason: "turnstile_failed",
      errorCodes: ["hostname-mismatch"]
    });

    const actionFetchMock = okFetch({
      success: true,
      hostname: "reservation.test",
      action: "reservation-preview"
    });

    const actionResult = await verifyTurnstileToken(
      {
        token: "turnstile_token",
        secret: "turnstile_secret",
        expectedHostname: "reservation.test",
        expectedAction: "reservation-submit"
      },
      actionFetchMock
    );

    expect(actionResult).toEqual({
      ok: false,
      reason: "turnstile_failed",
      errorCodes: ["action-mismatch"]
    });
  });

  it("treats malformed Turnstile JSON as a verification failure", async () => {
    const fetchMock = vi.fn(async () => new Response("not-json", { status: 200 })) as unknown as typeof fetch;

    const result = await verifyTurnstileToken(
      {
        token: "turnstile_token",
        secret: "turnstile_secret"
      },
      fetchMock
    );

    expect(result).toEqual({
      ok: false,
      reason: "turnstile_failed",
      errorCodes: ["invalid-json"]
    });
  });

  it("omits the Turnstile idempotency key when the caller does not provide one", async () => {
    const fetchMock = okFetch({
      success: true
    });

    const result = await verifyTurnstileToken(
      {
        token: "turnstile_token",
        secret: "turnstile_secret"
      },
      fetchMock
    );

    expect(result).toEqual({
      ok: true
    });
    const [, init] = vi.mocked(fetchMock).mock.calls[0] ?? [];
    await expect(new Response(init?.body).json()).resolves.toEqual({
      secret: "turnstile_secret",
      response: "turnstile_token"
    });
  });
});

describe("reservation public gate", () => {
  const D1_META = {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0
  };

  const emptyD1Result = <T = Record<string, unknown>>(): D1Result<T> => ({
    success: true,
    meta: D1_META,
    results: []
  });

  const emptyD1StatementResult = async <T = Record<string, unknown>>() => emptyD1Result<T>();
  const changedD1StatementResult = async <T = Record<string, unknown>>(): Promise<D1Result<T>> => ({
    success: true,
    meta: {
      ...D1_META,
      rows_written: 1,
      changed_db: true,
      changes: 1
    },
    results: []
  });

  const createPreparedStatement = (
    sql: string,
    blocked: boolean,
    rateLimitCount: number
  ): D1PreparedStatement => {
    let statement: D1PreparedStatement;
    const first = async <T = Record<string, unknown>>(): Promise<T | null> => {
      if (sql.includes("display_name")) {
        // Form-stage customer summary lookup: no on-file customer in these fakes.
        return null;
      }
      const row = sql.includes("COUNT(*) AS count")
        ? { count: rateLimitCount }
        : { is_blocked: blocked ? 1 : 0 };
      return row as T;
    };
    statement = {
        bind: () => statement,
        first,
        run: rateLimitCount >= 30 ? emptyD1StatementResult : changedD1StatementResult,
        all: emptyD1StatementResult,
        raw: emptyD1Raw
      };
    return statement;
  };

  const createDb = (blocked: boolean, rateLimitCount = 0): Pick<D1Database, "prepare"> => {
    return {
      prepare: vi.fn((sql: string) => createPreparedStatement(sql, blocked, rateLimitCount))
    };
  };

  const createGateRequest = (overrides: Partial<ReservationGateRequest> = {}): ReservationGateRequest => ({
    stage: "form",
    idToken: "id_token_1",
    nonce: "nonce_1",
    lineAccessToken: "line_access_token",
    turnstileToken: undefined,
    remoteIp: "203.0.113.10",
    ...overrides
  });

  it("allows form display only after LINE verification, friendship, and block checks", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          sub: "line_user_1",
          aud: "line_channel_id",
          exp: 1_800_000_000,
          iat: 1_700_000_000,
          nonce: "nonce_1"
        })
      )
      .mockResolvedValueOnce(Response.json({ userId: "line_user_1" }))
      .mockResolvedValueOnce(Response.json({ friendFlag: true })) as unknown as typeof fetch;

    const result = await evaluateReservationGate({
      request: createGateRequest(),
      env: {
        ...baseEnv,
        DB: createDb(false) as D1Database
      },
      fetcher: fetchMock,
      now: () => 1_700_000_000_000
    });

    expect(result).toEqual({
      allowed: true,
      lineUserId: "line_user_1",
      stage: "form"
    });
  });

  it("rejects form display when the LINE friendship check is false", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          sub: "line_user_1",
          aud: "line_channel_id",
          exp: 1_800_000_000,
          iat: 1_700_000_000,
          nonce: "nonce_1"
        })
      )
      .mockResolvedValueOnce(Response.json({ userId: "line_user_1" }))
      .mockResolvedValueOnce(Response.json({ friendFlag: false })) as unknown as typeof fetch;

    const result = await evaluateReservationGate({
      request: createGateRequest(),
      env: {
        ...baseEnv,
        DB: createDb(false) as D1Database
      },
      fetcher: fetchMock,
      now: () => 1_700_000_000_000
    });

    expect(result).toEqual({
      allowed: false,
      reason: "line_not_friend"
    });
  });

  it("requires Turnstile verification for submit stage", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;

    const result = await evaluateReservationGate({
      request: createGateRequest({
        stage: "submit"
      }),
      env: baseEnv,
      fetcher: fetchMock
    });

    expect(result).toEqual({
      allowed: false,
      reason: "missing_turnstile_token"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows LIFF gate checks when the verified ID token has no nonce claim", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          sub: "line_user_1",
          aud: "line_channel_id",
          exp: 1_800_000_000,
          iat: 1_700_000_000
        })
      )
      .mockResolvedValueOnce(Response.json({ userId: "line_user_1" }))
      .mockResolvedValueOnce(Response.json({ friendFlag: true })) as unknown as typeof fetch;

    const result = await evaluateReservationGate({
      request: {
        ...createGateRequest(),
        nonce: undefined
      },
      env: {
        ...baseEnv,
        DB: createDb(false) as D1Database
      },
      fetcher: fetchMock,
      now: () => 1_700_000_000_000
    });

    expect(result).toEqual({
      allowed: true,
      lineUserId: "line_user_1",
      stage: "form"
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails closed when the D1 binding is missing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          sub: "line_user_1",
          aud: "line_channel_id",
          exp: 1_800_000_000,
          iat: 1_700_000_000,
          nonce: "nonce_1"
        })
      )
      .mockResolvedValueOnce(Response.json({ userId: "line_user_1" }))
      .mockResolvedValueOnce(Response.json({ friendFlag: true })) as unknown as typeof fetch;

    const result = await evaluateReservationGate({
      request: createGateRequest(),
      env: baseEnv,
      fetcher: fetchMock,
      now: () => 1_700_000_000_000
    });

    expect(result).toEqual({
      allowed: false,
      reason: "customer_lookup_failed"
    });
  });

  it("rejects blocked LINE customers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          sub: "line_user_1",
          aud: "line_channel_id",
          exp: 1_800_000_000,
          iat: 1_700_000_000,
          nonce: "nonce_1"
        })
      )
      .mockResolvedValueOnce(Response.json({ userId: "line_user_1" }))
      .mockResolvedValueOnce(Response.json({ friendFlag: true })) as unknown as typeof fetch;

    const result = await evaluateReservationGate({
      request: createGateRequest(),
      env: {
        ...baseEnv,
        DB: createDb(true) as D1Database
      },
      fetcher: fetchMock,
      now: () => 1_700_000_000_000
    });

    expect(result).toEqual({
      allowed: false,
      reason: "customer_blocked"
    });
  });

  it("hashes rate limit keys instead of storing raw IPs or tokens", async () => {
    await expect(hashRateLimitKey("reservation_gate", "203.0.113.10")).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed before LINE APIs when the rate limit is exceeded", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;

    const result = await evaluateReservationGate({
      request: createGateRequest(),
      env: {
        ...baseEnv,
        DB: createDb(false, 30) as D1Database
      },
      fetcher: fetchMock
    });

    expect(result).toEqual({
      allowed: false,
      reason: "rate_limited"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed (rate_limited) when the client IP is missing", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;

    const result = await evaluateReservationGate({
      request: createGateRequest({ remoteIp: undefined }),
      env: {
        ...baseEnv,
        DB: createDb(false) as D1Database
      },
      fetcher: fetchMock,
      now: () => 1_700_000_000_000
    });

    // A missing IP must NOT collapse into the shared SHA256("...:unknown") bucket
    // — fail closed before any LINE / Turnstile call (CF-Connecting-IP is always
    // present for real ingress).
    expect(result).toEqual({
      allowed: false,
      reason: "rate_limited"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects mismatched LINE ID token and access-token users", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          sub: "line_user_1",
          aud: "line_channel_id",
          exp: 1_800_000_000,
          iat: 1_700_000_000,
          nonce: "nonce_1"
        })
      )
      .mockResolvedValueOnce(Response.json({ userId: "line_user_2" })) as unknown as typeof fetch;

    const result = await evaluateReservationGate({
      request: createGateRequest(),
      env: {
        ...baseEnv,
        DB: createDb(false) as D1Database
      },
      fetcher: fetchMock,
      now: () => 1_700_000_000_000
    });

    expect(result).toEqual({
      allowed: false,
      reason: "line_user_mismatch"
    });
  });

  it("records rate limit events with a hashed key", async () => {
    const run = vi.fn(async () => ({ success: true, meta: { changes: 1 } }));
    const first = vi.fn(async () => ({ count: 0 }));
    const bind = vi.fn((..._args: unknown[]) => ({ first, run }));
    const db = {
      prepare: vi.fn(() => ({ bind }))
    } as unknown as D1Database;

    await expect(enforceRateLimit(db, "reservation_gate", "203.0.113.10", () => 1_700_000_000_000)).resolves.toEqual({
      ok: true
    });

    const insertBindArgs = vi.mocked(bind).mock.calls.at(-1);
    expect(insertBindArgs?.[1]).toBe("reservation_gate");
    expect(insertBindArgs?.[2]).toMatch(/^[a-f0-9]{64}$/);
    expect(insertBindArgs).not.toContain("203.0.113.10");
  });

  it("fails open on a D1 error when failOpen=true, but fails closed by default", async () => {
    const throwingDb = {
      prepare: vi.fn(() => {
        throw new Error("d1_unavailable");
      })
    } as unknown as D1Database;

    // Admin mutation path (failOpen=true): a transient D1 blip must NOT lock a
    // trusted admin out — the mutation's own write would fail downstream anyway.
    await expect(
      enforceRateLimit(throwingDb, "admin_mutation", "admin-uuid-1", () => 1, 300, 600_000, true)
    ).resolves.toEqual({ ok: true });

    // Customer path (default failOpen=false): an attacker must not bypass the
    // limit by inducing errors — fail closed.
    await expect(
      enforceRateLimit(throwingDb, "reservation_gate", "203.0.113.10", () => 1)
    ).resolves.toEqual({ ok: false, reason: "rate_limited" });

    // Both directions still emit telemetry — failOpen silently disables the
    // limiter, failClosed silently throttles real customers (issue #467).
    // captureTransientD1 keeps the weekly export-lock visible on this
    // customer-facing rejection path.
    expect(vi.mocked(safeCaptureException)).toHaveBeenCalledWith(expect.any(Error), {
      tags: {
        component: "reservation-gate",
        op: "rate_limit_check_failed",
        helper: "enforceRateLimit"
      },
      captureTransientD1: true
    });
  });

  it("treats missing customer rows as not blocked and database errors as fail closed", async () => {
    const missingCustomerDb = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => null)
        }))
      }))
    } as unknown as D1Database;

    await expect(checkCustomerBlocked(missingCustomerDb, "line_channel_id", "line_user_1")).resolves.toEqual({
      ok: true,
      blocked: false
    });

    const failingDb = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => {
            throw new Error("db down");
          })
        }))
      }))
    } as unknown as D1Database;

    await expect(checkCustomerBlocked(failingDb, "line_channel_id", "line_user_1")).resolves.toEqual({
      ok: false,
      reason: "customer_lookup_failed"
    });
    // Fail-closed here blocks the whole booking flow for the customer, so the
    // D1 failure must reach telemetry instead of being swallowed (issue #467).
    // captureTransientD1 keeps the weekly export-lock visible on this
    // customer-facing denial path.
    expect(vi.mocked(safeCaptureException)).toHaveBeenCalledWith(expect.any(Error), {
      tags: {
        component: "reservation-gate",
        op: "customer_blocked_lookup_failed",
        helper: "checkCustomerBlocked"
      },
      captureTransientD1: true
    });
  });
});

describe("reservation public gate — recognized customer summary", () => {
  let d1: ReturnType<typeof createMigratedSqliteD1>;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  type FormCustomerSeed = {
    customerId: string;
    lineUserId: string;
    displayName: string;
    kana?: string | null;
    phone?: string | null;
    blocked?: boolean;
  };

  const seedFormCustomer = (seed: FormCustomerSeed): void => {
    d1.sqlite
      .prepare(
        `INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, phone_hash, block_status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`
      )
      .run(
        seed.customerId,
        seed.displayName,
        seed.kana ?? null,
        seed.phone ?? null,
        seed.phone ? "phone_hash_stub" : null,
        seed.blocked ? "blocked" : "active"
      );
    d1.sqlite
      .prepare(
        `INSERT INTO line_identities (id, customer_id, provider, channel_id, line_user_id, friend_flag, official_friend_status, last_friend_checked_at, updated_at)
         VALUES (?, ?, 'line', 'line_channel_id', ?, 1, 'friend', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run(`li-${seed.customerId}`, seed.customerId, seed.lineUserId);
  };

  const happyLineResponses = (sub: string) => [
    Response.json({ sub, aud: "line_channel_id", exp: 1_800_000_000, iat: 1_700_000_000, nonce: "nonce_1" }),
    Response.json({ userId: sub }),
    Response.json({ friendFlag: true })
  ];

  const formFetcher = (sub: string) => {
    const mock = vi.fn();
    for (const res of happyLineResponses(sub)) {
      mock.mockResolvedValueOnce(res);
    }
    return mock as unknown as typeof fetch;
  };

  const submitFetcher = (sub: string) => {
    const mock = vi.fn();
    mock.mockResolvedValueOnce(Response.json({ success: true }));
    for (const res of happyLineResponses(sub)) {
      mock.mockResolvedValueOnce(res);
    }
    return mock as unknown as typeof fetch;
  };

  const formRequest = (): ReservationGateRequest => ({
    stage: "form",
    idToken: "id_token_1",
    nonce: "nonce_1",
    lineAccessToken: "line_access_token",
    turnstileToken: undefined,
    remoteIp: "203.0.113.10"
  });

  it("returns the masked on-file contact for a recognized existing customer (no full phone)", async () => {
    seedFormCustomer({ customerId: "c1", lineUserId: "U1", displayName: "山田 花子", kana: "ヤマダ ハナコ", phone: "09012345678" });
    const result = await evaluateReservationGate({
      request: formRequest(),
      env: { ...baseEnv, DB: d1 as unknown as D1Database },
      fetcher: formFetcher("U1"),
      now: () => 1_700_000_000_000
    });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.customer).toEqual({
      displayName: "山田 花子",
      displayNameKana: "ヤマダ ハナコ",
      phoneMasked: "****5678"
    });
    expect(JSON.stringify(result)).not.toContain("09012345678");
    expect(JSON.stringify(result)).not.toContain("phone_hash");
  });

  it("returns phoneMasked=null when the existing customer has no phone on file", async () => {
    seedFormCustomer({ customerId: "c2", lineUserId: "U2", displayName: "紙カルテ 太郎", kana: null, phone: null });
    const result = await evaluateReservationGate({
      request: formRequest(),
      env: { ...baseEnv, DB: d1 as unknown as D1Database },
      fetcher: formFetcher("U2"),
      now: () => 1_700_000_000_000
    });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.customer).toEqual({ displayName: "紙カルテ 太郎", displayNameKana: null, phoneMasked: null });
  });

  it("returns no customer summary for an unrecognized LINE user", async () => {
    const result = await evaluateReservationGate({
      request: formRequest(),
      env: { ...baseEnv, DB: d1 as unknown as D1Database },
      fetcher: formFetcher("U_unknown"),
      now: () => 1_700_000_000_000
    });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.customer).toBeUndefined();
  });

  it("does not attach a customer summary on the submit stage", async () => {
    seedFormCustomer({ customerId: "c3", lineUserId: "U3", displayName: "山田 花子", phone: "09012345678" });
    const result = await evaluateReservationGate({
      request: { ...formRequest(), stage: "submit", turnstileToken: "tt" },
      env: { ...baseEnv, DB: d1 as unknown as D1Database },
      fetcher: submitFetcher("U3"),
      now: () => 1_700_000_000_000
    });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.customer).toBeUndefined();
  });
});
