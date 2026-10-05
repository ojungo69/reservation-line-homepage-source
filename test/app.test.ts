import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { createMigratedSqliteD1 } from "./helpers/sqlite-d1";

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

async function emptyD1Raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
async function emptyD1Raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
async function emptyD1Raw<T = unknown[]>(options?: { columnNames?: boolean }) {
  return options?.columnNames ? [[]] : [];
}

const createPreparedStatement = (sql: string, blocked: boolean): D1PreparedStatement => {
  let statement: D1PreparedStatement;
  const first = async <T = Record<string, unknown>>(): Promise<T | null> => {
    if (sql.includes("display_name")) {
      // Form-stage customer summary lookup: no on-file customer in these fakes.
      return null;
    }
    const row = sql.includes("COUNT(*) AS count")
      ? { count: 0 }
      : { is_blocked: blocked ? 1 : 0 };
    return row as T;
  };
  statement = {
    bind: () => statement,
    first,
    run: changedD1StatementResult,
    all: emptyD1StatementResult,
    raw: emptyD1Raw
  };
  return statement;
};

const createDb = (blocked: boolean): Pick<D1Database, "prepare"> => {
  return {
    prepare: vi.fn((sql: string) => createPreparedStatement(sql, blocked))
  };
};

const expectNoPrivateResponseHeaders = (response: Response) => {
  expect(response.headers.get("cache-control")).toBeNull();
  expect(response.headers.get("pragma")).toBeNull();
};

const expectPrivateReservationResponse = (response: Response) => {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
};

const createQueueMock = () => {
  return {
    send: vi.fn(async () => undefined)
  } as unknown as Queue<unknown> & { send: ReturnType<typeof vi.fn> };
};

const createExecutionContextMock = () => {
  const waitUntilPromises: Promise<unknown>[] = [];
  return {
    waitUntilPromises,
    executionCtx: {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      },
      passThroughOnException: vi.fn()
    } as unknown as ExecutionContext
  };
};

type PublicReservationOptionsResponse = {
  stores: Array<{ id: string; name: string; timezone: string; bookingWindowDays: number; customerNotice: string | null }>;
  services: Array<{ id: string; storeId: string; name: string; priceLabel: string | null; priceAmount: number | null; comboPriceAmount: number | null; comboWithPrefix: string | null; durationMinutes: number }>;
  resources: unknown[];
};

type PublicAvailabilityResponse = {
  availabilityStatus: "ready" | "unavailable";
  serviceIds?: string[];
  durationMinutes: number;
  slots: { startAt: string; endAt: string }[];
};

describe("reservation worker API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns a health response with the active spec version", async () => {
    const app = createApp();
    const response = await app.request(
      "/api/health",
      {},
      {
        ENVIRONMENT: "test",
        SPEC_VERSION: "v1.5-draft"
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
    expectNoPrivateResponseHeaders(response);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: "pass",
      service: "reservation-line-homepage",
      environment: "test",
      specVersion: "v1.5-draft"
    });
  });

  it("returns ok:true when D1 SELECT 1 succeeds", async () => {
    const app = createApp();
    const statement = {
      first: vi.fn(async () => ({ "1": 1 })),
      bind: vi.fn(),
      run: emptyD1StatementResult,
      all: emptyD1StatementResult,
      raw: emptyD1Raw
    } as unknown as D1PreparedStatement;
    const db = {
      prepare: vi.fn(() => statement)
    } as unknown as D1Database;

    const response = await app.request(
      "/api/health",
      {},
      {
        ENVIRONMENT: "test",
        SPEC_VERSION: "v1.5-draft",
        DB: db
      }
    );

    expect(response.status).toBe(200);
    expect(db.prepare).toHaveBeenCalledWith("SELECT 1");
    expect(statement.first).toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: "pass",
      service: "reservation-line-homepage",
      environment: "test",
      specVersion: "v1.5-draft"
    });
  });

  it("returns ok:true during transient D1 export lock (not 503)", async () => {
    const app = createApp();
    const statement = {
      first: vi.fn(async () => {
        throw new Error("D1_ERROR: Currently processing a long-running export.");
      }),
      bind: vi.fn(),
      run: emptyD1StatementResult,
      all: emptyD1StatementResult,
      raw: emptyD1Raw
    } as unknown as D1PreparedStatement;
    const db = {
      prepare: vi.fn(() => statement)
    } as unknown as D1Database;

    const response = await app.request(
      "/api/health",
      {},
      {
        ENVIRONMENT: "test",
        SPEC_VERSION: "v1.5-draft",
        DB: db
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-sdj-health-status")).toBe("warn");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: "warn",
      service: "reservation-line-homepage",
      environment: "test",
      specVersion: "v1.5-draft",
      reason: "d1_export_locked"
    });
  });

  it("returns 503 ok:false on non-transient D1 errors", async () => {
    const app = createApp();
    const statement = {
      first: vi.fn(async () => {
        throw new Error("D1_ERROR: no such table");
      }),
      bind: vi.fn(),
      run: emptyD1StatementResult,
      all: emptyD1StatementResult,
      raw: emptyD1Raw
    } as unknown as D1PreparedStatement;
    const db = {
      prepare: vi.fn(() => statement)
    } as unknown as D1Database;

    const response = await app.request(
      "/api/health",
      {},
      {
        ENVIRONMENT: "test",
        SPEC_VERSION: "v1.5-draft",
        DB: db
      }
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      status: "fail",
      service: "reservation-line-homepage",
      environment: "test",
      specVersion: "v1.5-draft",
      reason: "d1_unreachable"
    });
  });

  it("uses JSON 404 responses for unknown API routes", async () => {
    const app = createApp();
    const response = await app.request("/api/missing");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "not_found"
    });
  });

  it("does not add private reservation cache headers to public version metadata", async () => {
    const app = createApp();
    const response = await app.request(
      "/api/version",
      {},
      {
        SPEC_VERSION: "v1.5-draft"
      }
    );

    expect(response.status).toBe(200);
    expectNoPrivateResponseHeaders(response);
    await expect(response.json()).resolves.toEqual({
      specVersion: "v1.5-draft"
    });
  });

  it("serves public reservation options without exposing secret bindings", async () => {
    const app = createApp();
    const d1 = createMigratedSqliteD1();

    try {
      // Per-store customer notice round-trips through the options endpoint (textContent
      // on the client). Set one store's notice; the others stay null.
      d1.sqlite
        .prepare("UPDATE store_settings SET customer_notice = ? WHERE store_id = 'kyoto'")
        .run("水曜・土曜はメンズデーとなっております。");
      d1.sqlite
        .prepare("UPDATE services SET price_label = ?, price_amount = ?, combo_price_amount = ?, combo_with_prefix = ? WHERE id = 'service_kyoto_hair_removal_full_60'")
        .run("10,000円（税込）", 10_000, 8_000, "脱毛");
      d1.sqlite
        .prepare("UPDATE services SET price_label = NULL WHERE id = 'service_kyoto_hair_removal_upper_focus_45'")
        .run();

      const response = await app.request(
        "/api/public/reservation-options",
        {},
        {
          DB: d1 as unknown as D1Database,
          LINE_LIFF_ID: "1234567890-AbcdEfgh",
          TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
          TURNSTILE_EXPECTED_ACTION: "reservation-submit",
          LINE_CHANNEL_SECRET: "do_not_expose"
        }
      );

      expect(response.status).toBe(200);
      expectPrivateReservationResponse(response);
      const body = (await response.json()) as PublicReservationOptionsResponse;
      expect(body).toMatchObject({
        ok: true,
        liffId: "1234567890-AbcdEfgh",
        turnstile: {
          siteKey: "1x00000000000000000000AA",
          action: "reservation-submit"
        }
      });
      expect(body.stores).toHaveLength(4);
      const kyotoStore = body.stores.find((store) => store.id === "kyoto");
      expect(kyotoStore?.customerNotice).toBe("水曜・土曜はメンズデーとなっております。");
      const osakaStore = body.stores.find((store) => store.id === "osaka");
      expect(osakaStore?.customerNotice).toBeNull();
      expect(body.services).toHaveLength(129);
      expect(body.resources.length).toBeGreaterThan(0);
      expect(JSON.stringify(body)).not.toContain("do_not_expose");
      expect(JSON.stringify(body)).not.toContain("Google Calendar");
      expect(JSON.stringify(body)).toContain("脱毛｜サンプル 11");
      expect(JSON.stringify(body)).toContain("脱毛｜サンプル 14");
      expect(JSON.stringify(body)).toContain("脱毛｜サンプル 15");
      expect(JSON.stringify(body)).toContain("脱毛｜サンプル 13");
      expect(JSON.stringify(body)).not.toContain("脱毛｜サンプル 12");
      expect(JSON.stringify(body)).toContain("マッサージ｜サンプル 04");
      const kyotoServices = body.services.filter((service) => service.storeId === "kyoto");
      expect(kyotoServices.find((service) => service.id === "service_kyoto_hair_removal_full_60")?.priceLabel).toBe("10,000円（税込）");
      expect(kyotoServices.find((service) => service.id === "service_kyoto_hair_removal_upper_focus_45")?.priceLabel).toBeNull();
      expect(kyotoServices.find((service) => service.id === "service_kyoto_hair_removal_full_60")).toMatchObject({
        priceAmount: 10_000,
        comboPriceAmount: 8_000,
        comboWithPrefix: "脱毛"
      });
      expect(kyotoServices.find((service) => service.id === "service_kyoto_hair_removal_upper_focus_45")).toMatchObject({
        priceAmount: null,
        comboPriceAmount: null,
        comboWithPrefix: null
      });
      expect(kyotoServices.slice(0, 4).map((service) => [service.id, service.durationMinutes])).toEqual([
        ["service_kyoto_hair_removal_full_60", 45],
        ["service_kyoto_hair_removal_upper_focus_45", 45],
        ["service_kyoto_hair_removal_lower_focus_45", 45],
        ["service_kyoto_hair_removal_growth_45", 45]
      ]);
      const firstMensMenuIndex = kyotoServices.findIndex(
        (service) => service.name.startsWith("メンズ｜")
      );
      const lastHairRemovalIndex = kyotoServices.reduce(
        (lastIndex, service, index) => service.name.startsWith("脱毛｜") ? index : lastIndex,
        -1
      );
      expect(firstMensMenuIndex).toBeGreaterThan(lastHairRemovalIndex);
      expect(firstMensMenuIndex).toBeLessThan(
        kyotoServices.findIndex(
          (service) => service.id === "service_kyoto_facial_hydra_photo_60"
        )
      );
    } finally {
      d1.sqlite.close();
    }
  });

  it("serves public availability and removes slot-locked times", async () => {
    vi.useFakeTimers({
      now: new Date("2026-05-09T00:00:00.000Z")
    });
    const app = createApp();
    const d1 = createMigratedSqliteD1();
    d1.sqlite
      .prepare(
        `
          INSERT INTO slot_locks (id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status)
          VALUES ('lock_public_options_1', 'kyoto', 'resource_kyoto_calendar', '2026-06-01T01:00:00.000Z', 'reservation', 'reservation_existing_1', 'confirmed')
        `
      )
      .run();

    try {
      const response = await app.request(
        "/api/public/availability?storeId=kyoto&serviceId=service_kyoto_default_60&resourceId=resource_kyoto_calendar&date=2026-06-01",
        {},
        {
          DB: d1 as unknown as D1Database
        }
      );

      expect(response.status).toBe(200);
      expectPrivateReservationResponse(response);
      const body = (await response.json()) as PublicAvailabilityResponse;
      expect(body).toMatchObject({
        ok: true,
        storeId: "kyoto",
        availabilityStatus: "ready",
        durationMinutes: 65
      });
      const startTimes = body.slots.map((slot: { startAt: string }) => slot.startAt);
      expect(startTimes).not.toContain("2026-06-01T01:00:00.000Z");
      expect(startTimes).toContain("2026-06-01T02:00:00.000Z");
    } finally {
      d1.sqlite.close();
    }
  });

  it("distinguishes an empty checked day from unavailable Google verification over HTTP", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-09T00:00:00.000Z") });
    const app = createApp();
    const d1 = createMigratedSqliteD1();
    const base = "/api/public/availability?storeId=kyoto&serviceId=service_kyoto_default_60&resourceId=resource_kyoto_calendar";

    try {
      // Friday is closed by store hours, but the availability check itself completed.
      const empty = await app.request(`${base}&date=2026-06-05`, {}, {
        DB: d1 as unknown as D1Database
      });
      expect(empty.status).toBe(200);
      expectPrivateReservationResponse(empty);
      expect(await empty.json()).toMatchObject({ ok: true, availabilityStatus: "ready", slots: [] });

      // With live checking enabled but no service-account credentials, fail closed.
      const unavailable = await app.request(`${base}&date=2026-06-01`, {}, {
        DB: d1 as unknown as D1Database,
        GOOGLE_IMPORT_ENABLED: "true",
        GOOGLE_LIVE_AVAILABILITY_ENABLED: "true"
      });
      expect(unavailable.status).toBe(200);
      expectPrivateReservationResponse(unavailable);
      expect(await unavailable.json()).toMatchObject({ ok: true, availabilityStatus: "unavailable", slots: [] });

      const invalid = await app.request(`${base}&date=2026-06-00`, {}, {
        DB: d1 as unknown as D1Database
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ ok: false, reason: "invalid_request" });
    } finally {
      d1.sqlite.close();
    }
  });

  it("serves multi-menu availability with one reservation interval and 5-minute internal locks", async () => {
    vi.useFakeTimers({
      now: new Date("2026-05-09T00:00:00.000Z")
    });
    const app = createApp();
    const d1 = createMigratedSqliteD1();
    d1.sqlite
      .prepare(
        `
          INSERT INTO slot_locks (id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status)
          VALUES ('lock_multi_menu_1', 'kyoto', 'resource_kyoto_calendar', '2026-06-01T01:45:00.000Z', 'reservation', 'reservation_existing_1', 'confirmed')
        `
      )
      .run();

    try {
      const params = new URLSearchParams({
        storeId: "kyoto",
        serviceIds: [
          "service_kyoto_hair_removal_full_60",
          "service_kyoto_facial_photo_30"
        ].join(","),
        resourceId: "resource_kyoto_calendar",
        date: "2026-06-01"
      });
      const response = await app.request(`/api/public/availability?${params.toString()}`, {}, {
        DB: d1 as unknown as D1Database
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as PublicAvailabilityResponse;
      // 全身脱毛（45分）+ フォト光（5分）はフォト光を吸収して 45 + 5(バッファ) = 50分占有。
      expect(body).toMatchObject({
        ok: true,
        storeId: "kyoto",
        serviceIds: [
          "service_kyoto_hair_removal_full_60",
          "service_kyoto_facial_photo_30"
        ],
        durationMinutes: 50
      });
      // 01:00 開始は 01:00–01:50 を占有し 01:45 の既存ロックと衝突するため候補に出ない。
      const oneAmSlot = body.slots.find((slot) => slot.startAt === "2026-06-01T01:00:00.000Z");
      expect(oneAmSlot).toBeUndefined();
      const twoAmSlot = body.slots.find((slot) => slot.startAt === "2026-06-01T02:00:00.000Z");
      expect(twoAmSlot?.endAt).toBe("2026-06-01T02:50:00.000Z");
    } finally {
      d1.sqlite.close();
    }
  });

  it("rejects reservation gate requests that only provide decoded LINE payloads", async () => {
    const app = createApp();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request(
      "/api/public/reservation-gate",
      {
        method: "POST",
        body: JSON.stringify({
          stage: "form",
          decodedIdToken: {
            sub: "line_user_1"
          },
          lineAccessToken: "line_access_token"
        }),
        headers: {
          "Content-Type": "application/json"
        }
      },
      {
        LINE_CHANNEL_ID: "line_channel_id",
        DB: createDb(false) as D1Database
      }
    );

    expect(response.status).toBe(400);
    expectPrivateReservationResponse(response);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows LIFF reservation gate requests when LINE returns no nonce claim", async () => {
    const app = createApp();
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
      .mockResolvedValueOnce(Response.json({ friendFlag: true }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request(
      "/api/public/reservation-gate",
      {
        method: "POST",
        body: JSON.stringify({
          stage: "form",
          idToken: "id_token_1",
          lineAccessToken: "line_access_token"
        }),
        headers: {
          "Content-Type": "application/json",
          // CF sets this on every real ingress; the gate now fails closed without it.
          "CF-Connecting-IP": "203.0.113.10"
        }
      },
      {
        LINE_CHANNEL_ID: "line_channel_id",
        DB: createDb(false) as D1Database
      }
    );

    expect(response.status).toBe(200);
    expectPrivateReservationResponse(response);
    await expect(response.json()).resolves.toEqual({
      allowed: true,
      lineUserId: "line_user_1",
      stage: "form"
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("allows the public reservation form gate after server-side LINE and friendship checks", async () => {
    const app = createApp();
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
      .mockResolvedValueOnce(Response.json({ friendFlag: true }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request(
      "/api/public/reservation-gate",
      {
        method: "POST",
        body: JSON.stringify({
          stage: "form",
          idToken: "id_token_1",
          nonce: "nonce_1",
          lineAccessToken: "line_access_token"
        }),
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.10"
        }
      },
      {
        LINE_CHANNEL_ID: "line_channel_id",
        DB: createDb(false) as D1Database
      }
    );

    expect(response.status).toBe(200);
    expectPrivateReservationResponse(response);
    await expect(response.json()).resolves.toEqual({
      allowed: true,
      lineUserId: "line_user_1",
      stage: "form"
    });
  });

  it("rejects the public reservation gate when friendship is false", async () => {
    const app = createApp();
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
      .mockResolvedValueOnce(Response.json({ friendFlag: false }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request(
      "/api/public/reservation-gate",
      {
        method: "POST",
        body: JSON.stringify({
          stage: "form",
          idToken: "id_token_1",
          nonce: "nonce_1",
          lineAccessToken: "line_access_token"
        }),
        headers: {
          "Content-Type": "application/json",
          // CF sets this on every real ingress; the gate now fails closed without it.
          "CF-Connecting-IP": "203.0.113.10"
        }
      },
      {
        LINE_CHANNEL_ID: "line_channel_id",
        DB: createDb(false) as D1Database
      }
    );

    expect(response.status).toBe(403);
    expectPrivateReservationResponse(response);
    await expect(response.json()).resolves.toEqual({
      allowed: false,
      reason: "line_not_friend"
    });
  });

  it("creates a public reservation after submit-stage auth checks pass", async () => {
    // Freeze only Date (keep real timers for async queue flow) so the hard-coded
    // 2026-06-01 slot stays in the future regardless of wall-clock run date.
    vi.useFakeTimers({ now: new Date("2026-05-09T00:00:00.000Z"), toFake: ["Date"] });
    const app = createApp();
    const d1 = createMigratedSqliteD1();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ success: true, hostname: "reservation.test", action: "reservation-submit" }))
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
      .mockResolvedValueOnce(Response.json({ friendFlag: true }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const response = await app.request(
        "/api/public/reservations",
        {
          method: "POST",
          body: JSON.stringify({
            idToken: "id_token_1",
            nonce: "nonce_1",
            lineAccessToken: "line_access_token",
            turnstileToken: "turnstile_token",
            idempotencyKey: "public_submit_api_1",
            storeId: "kyoto",
            serviceId: "service_kyoto_default_60",
            resourceId: "resource_kyoto_calendar",
            startAt: "2026-06-01T01:00:00.000Z",
            customer: {
              displayName: "予約 太郎",
              displayNameKana: "ヨヤク タロウ",
              phone: "075-123-4567"
            },
            consents: {
              noticeVersion: "notice-terms-2026-06",
              cancellationPolicyVersion: "cancel-2026-08-31",
              privacyPolicyVersion: "privacy-2026-06"
            }
          }),
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": "203.0.113.10"
          }
        },
        {
          LINE_CHANNEL_ID: "line_channel_id",
          TURNSTILE_SECRET_KEY: "turnstile_secret",
          TURNSTILE_EXPECTED_HOSTNAME: "reservation.test",
          TURNSTILE_EXPECTED_ACTION: "reservation-submit",
          DB: d1 as unknown as D1Database
        }
      );

      expect(response.status).toBe(201);
      expectPrivateReservationResponse(response);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        status: "pending_approval",
        storeId: "kyoto",
        replayed: false
      });
      const reservationCount = d1.sqlite.prepare("SELECT COUNT(*) AS count FROM reservations").get() as { count: number };
      expect(reservationCount.count).toBe(1);
    } finally {
      d1.sqlite.close();
    }
  });

  it("gates men's-menu POSTs on the Kyoto weekday + start-time window", async () => {
    // Freeze only Date (keep real timers for async queue flow) so the hard-coded
    // 2026-06-01 slot stays in the future regardless of wall-clock run date.
    vi.useFakeTimers({ now: new Date("2026-05-09T00:00:00.000Z"), toFake: ["Date"] });
    const app = createApp();
    const d1 = createMigratedSqliteD1();
    // Every POST below burns the same 4 auth round-trips (turnstile, id_token
    // verify, userinfo, friendship), so build them per request instead of one
    // hand-written chain. The last request uses a second LINE user because the
    // web cap (migration 0045) allows one active reservation per customer and
    // this test needs two accepted bookings.
    const bookers = [
      { lineUserId: "line_user_1", phone: "075-123-4567" },
      { lineUserId: "line_user_1", phone: "075-123-4567" },
      { lineUserId: "line_user_1", phone: "075-123-4567" },
      { lineUserId: "line_user_2", phone: "075-123-4568" }
    ];
    const fetchMock = vi.fn();
    for (const booker of bookers) {
      fetchMock
        .mockResolvedValueOnce(Response.json({ success: true, hostname: "reservation.test", action: "reservation-submit" }))
        .mockResolvedValueOnce(
          Response.json({
            sub: booker.lineUserId,
            aud: "line_channel_id",
            exp: 1_800_000_000,
            iat: 1_700_000_000,
            nonce: "nonce_1"
          })
        )
        .mockResolvedValueOnce(Response.json({ userId: booker.lineUserId }))
        .mockResolvedValueOnce(Response.json({ friendFlag: true }));
    }
    vi.stubGlobal("fetch", fetchMock);

    try {
      const postMensReservation = (startAt: string, idempotencyKey: string, remoteIp: string, phone = "075-123-4567") =>
        app.request(
          "/api/public/reservations",
          {
            method: "POST",
            body: JSON.stringify({
              idToken: "id_token_1",
              nonce: "nonce_1",
              lineAccessToken: "line_access_token",
              turnstileToken: "turnstile_token",
              idempotencyKey,
              storeId: "kyoto",
              serviceId: "service_kyoto_mens_hair_removal_beard_30",
              resourceId: "resource_kyoto_calendar",
              startAt,
              customer: {
                displayName: "予約 太郎",
                displayNameKana: "ヨヤク タロウ",
                phone
              },
              consents: {
                noticeVersion: "notice-terms-2026-06",
                cancellationPolicyVersion: "cancel-2026-08-31",
                privacyPolicyVersion: "privacy-2026-06"
              }
            }),
            headers: {
              "Content-Type": "application/json",
              "CF-Connecting-IP": remoteIp
            }
          },
          {
            LINE_CHANNEL_ID: "line_channel_id",
            TURNSTILE_SECRET_KEY: "turnstile_secret",
            TURNSTILE_EXPECTED_HOSTNAME: "reservation.test",
            TURNSTILE_EXPECTED_ACTION: "reservation-submit",
            DB: d1 as unknown as D1Database
          }
        );

      const monday = await postMensReservation(
        "2026-06-01T01:00:00.000Z",
        "public_submit_mens_monday",
        "203.0.113.10"
      );
      expect(monday.status).toBe(400);
      await expect(monday.json()).resolves.toEqual({
        ok: false,
        reason: "outside_business_hours"
      });

      const tuesday = await postMensReservation(
        "2026-06-02T01:00:00.000Z",
        "public_submit_mens_tuesday",
        "203.0.113.11"
      );
      expect(tuesday.status).toBe(201);
      expectPrivateReservationResponse(tuesday);
      await expect(tuesday.json()).resolves.toMatchObject({
        ok: true,
        status: "pending_approval",
        storeId: "kyoto",
        replayed: false
      });

      // Wednesday is afternoon-only, so the write path must reject 12:00 JST and
      // accept 13:00 JST. Tuesday alone cannot catch a broken start-time compare
      // (it keeps the store's full hours), which is why both sides are pinned here.
      const wednesdayNoon = await postMensReservation(
        "2026-06-03T03:00:00.000Z",
        "public_submit_mens_wednesday_noon",
        "203.0.113.12"
      );
      expect(wednesdayNoon.status).toBe(400);
      await expect(wednesdayNoon.json()).resolves.toEqual({
        ok: false,
        reason: "outside_business_hours"
      });

      const wednesdayAfternoon = await postMensReservation(
        "2026-06-03T04:00:00.000Z",
        "public_submit_mens_wednesday_afternoon",
        "203.0.113.13",
        "075-123-4568"
      );
      expect(wednesdayAfternoon.status).toBe(201);

      const reservationCount = d1.sqlite.prepare("SELECT COUNT(*) AS count FROM reservations").get() as { count: number };
      expect(reservationCount.count).toBe(2);
    } finally {
      d1.sqlite.close();
    }
  });

  it("fails closed when the verified LINE customer has been archived (no reservation created)", async () => {
    // codex PR-B blocking: an archived (soft-deleted) customer must not resurface
    // through the public LINE booking path even though their line_identity still exists.
    vi.useFakeTimers({ now: new Date("2026-05-09T00:00:00.000Z"), toFake: ["Date"] });
    const app = createApp();
    const d1 = createMigratedSqliteD1();
    d1.sqlite
      .prepare(
        `INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status, archived_at, updated_at)
         VALUES ('cust_archived_1', 'アーカイブ 客', '09011112222', 'hash_archived_1', 'active', '2026-05-08T00:00:00.000Z', '2026-05-08T00:00:00.000Z')`
      )
      .run();
    d1.sqlite
      .prepare(
        `INSERT INTO line_identities (id, customer_id, provider, channel_id, line_user_id)
         VALUES ('li_archived_1', 'cust_archived_1', 'line', 'line_channel_id', 'line_user_1')`
      )
      .run();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ success: true, hostname: "reservation.test", action: "reservation-submit" }))
      .mockResolvedValueOnce(
        Response.json({ sub: "line_user_1", aud: "line_channel_id", exp: 1_800_000_000, iat: 1_700_000_000, nonce: "nonce_1" })
      )
      .mockResolvedValueOnce(Response.json({ userId: "line_user_1" }))
      .mockResolvedValueOnce(Response.json({ friendFlag: true }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const response = await app.request(
        "/api/public/reservations",
        {
          method: "POST",
          body: JSON.stringify({
            idToken: "id_token_1",
            nonce: "nonce_1",
            lineAccessToken: "line_access_token",
            turnstileToken: "turnstile_token",
            idempotencyKey: "public_submit_archived_1",
            storeId: "kyoto",
            serviceId: "service_kyoto_default_60",
            resourceId: "resource_kyoto_calendar",
            startAt: "2026-06-01T01:00:00.000Z",
            customer: { displayName: "アーカイブ 客", displayNameKana: "アーカイブ キャク", phone: "090-1111-2222" },
            consents: {
              noticeVersion: "notice-terms-2026-06",
              cancellationPolicyVersion: "cancel-2026-08-31",
              privacyPolicyVersion: "privacy-2026-06"
            }
          }),
          headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.11" }
        },
        {
          LINE_CHANNEL_ID: "line_channel_id",
          TURNSTILE_SECRET_KEY: "turnstile_secret",
          TURNSTILE_EXPECTED_HOSTNAME: "reservation.test",
          TURNSTILE_EXPECTED_ACTION: "reservation-submit",
          DB: d1 as unknown as D1Database
        }
      );

      // Archived customers are denied at the reservation gate (checkCustomerBlocked
      // treats archived like blocked), so the request fails closed with 403
      // customer_blocked before reaching the booking write. Pin the status/reason so
      // an unrelated 500 cannot pass this test.
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ ok: false, reason: "auth_failed" });
      const reservationCount = d1.sqlite.prepare("SELECT COUNT(*) AS count FROM reservations").get() as { count: number };
      expect(reservationCount.count).toBe(0);
    } finally {
      d1.sqlite.close();
    }
  });

  it("kicks Google and LINE queues after successful public reservation creation", async () => {
    // Freeze only Date (keep real timers for async queue flow) so the hard-coded
    // 2026-06-01 slot stays in the future regardless of wall-clock run date.
    vi.useFakeTimers({ now: new Date("2026-05-09T00:00:00.000Z"), toFake: ["Date"] });
    const app = createApp();
    const d1 = createMigratedSqliteD1();
    const googleQueue = createQueueMock();
    const lineQueue = createQueueMock();
    const { executionCtx, waitUntilPromises } = createExecutionContextMock();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ success: true, hostname: "reservation.test", action: "reservation-submit" }))
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
      .mockResolvedValueOnce(Response.json({ friendFlag: true }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const response = await app.fetch(
        new Request("https://reservation.test/api/public/reservations", {
          method: "POST",
          body: JSON.stringify({
            idToken: "id_token_1",
            nonce: "nonce_1",
            lineAccessToken: "line_access_token",
            turnstileToken: "turnstile_token",
            idempotencyKey: "public_submit_api_queue_1",
            storeId: "kyoto",
            serviceId: "service_kyoto_default_60",
            resourceId: "resource_kyoto_calendar",
            startAt: "2026-06-01T02:00:00.000Z",
            customer: {
              displayName: "予約 花子",
              displayNameKana: "ヨヤク ハナコ",
              phone: "075-123-4568"
            },
            consents: {
              noticeVersion: "notice-terms-2026-06",
              cancellationPolicyVersion: "cancel-2026-08-31",
              privacyPolicyVersion: "privacy-2026-06"
            }
          }),
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": "203.0.113.10"
          }
        }),
        {
          LINE_CHANNEL_ID: "line_channel_id",
          TURNSTILE_SECRET_KEY: "turnstile_secret",
          TURNSTILE_EXPECTED_HOSTNAME: "reservation.test",
          TURNSTILE_EXPECTED_ACTION: "reservation-submit",
          DB: d1 as unknown as D1Database,
          GOOGLE_SYNC_QUEUE: googleQueue,
          LINE_NOTIFICATION_QUEUE: lineQueue
        },
        executionCtx
      );

      expect(response.status).toBe(201);
      await Promise.all(waitUntilPromises);
      expect(googleQueue.send).toHaveBeenCalledWith({ type: "google_sync_job_available" });
      expect(lineQueue.send).toHaveBeenCalledWith({ type: "line_notification_job_available" });
    } finally {
      d1.sqlite.close();
    }
  });
});
