import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import * as lineApi from "../src/auth/line";
import { createMigratedSqliteD1 } from "./helpers/sqlite-d1";

// GET /api/public/my-reservations の契約テスト。キャンセル申請機能の全廃 (2026-08-01)
// 後もレスポンス形は旧クライアント互換で維持され、requestable は両アクションとも
// 常に closed、pendingChangeRequest / historyCount は固定値になる。
// 旧 change-request 系 7 ルートの 404 到達性テストも兼ねる。

const LINE_USER_ID = "U" + "f".repeat(32);

const seedReservation = (
  d1: ReturnType<typeof createMigratedSqliteD1>,
  overrides: { startAt: string; endAt: string; duration?: number } = {
    startAt: "2026-08-01T01:00:00.000Z",
    endAt: "2026-08-01T02:00:00.000Z"
  }
) => {
  d1.sqlite.prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, ?)`).run("store_t", "S", "Asia/Tokyo");
  d1.sqlite
    .prepare(`INSERT INTO store_resources (id, store_id, name) VALUES (?, ?, ?)`)
    .run("resource_t", "store_t", "R");
  d1.sqlite
    .prepare(`INSERT INTO customers (id, display_name, phone_normalized, phone_hash) VALUES (?, ?, ?, ?)`)
    .run("customer_t", "Customer", "0700000000", "ph");
  d1.sqlite
    .prepare(
      `INSERT INTO line_identities (id, customer_id, provider, channel_id, line_user_id) VALUES (?, ?, ?, ?, ?)`
    )
    .run("identity_t", "customer_t", "line", "channel_t", LINE_USER_ID);
  d1.sqlite
    .prepare(`INSERT INTO services (id, store_id, name, duration_minutes) VALUES (?, ?, ?, ?)`)
    .run("service_t", "store_t", "S", overrides.duration ?? 60);
  d1.sqlite
    .prepare(
      `INSERT INTO reservations (
        id, store_id, service_id, customer_id, resource_id, line_identity_id, source, status,
        start_at, end_at, duration_minutes, idempotency_key, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "reservation_t",
      "store_t",
      "service_t",
      "customer_t",
      "resource_t",
      "identity_t",
      "web_line",
      "confirmed",
      overrides.startAt,
      overrides.endAt,
      overrides.duration ?? 60,
      "idem_t",
      1
    );
};

// 廃止前に作られた stale pending 申請の残骸。一覧に出ないことを検証する。
const seedLegacyPendingChangeRequest = (d1: ReturnType<typeof createMigratedSqliteD1>) => {
  d1.sqlite
    .prepare(
      `INSERT INTO reservation_change_requests (
        id, reservation_id, customer_id, line_identity_id, request_type, status,
        reservation_version_at_request, current_start_at, current_end_at,
        created_at, updated_at
      ) SELECT ?, id, customer_id, line_identity_id, 'cancel', 'pending',
               version, start_at, end_at, ?, ?
        FROM reservations WHERE id = 'reservation_t'`
    )
    .run("legacy_request_t", "2026-07-31T00:00:00.000Z", "2026-07-31T00:00:00.000Z");
};

const stubLineApi = () => {
  vi.spyOn(lineApi, "verifyLineIdToken").mockResolvedValue({
    ok: true,
    payload: {
      sub: LINE_USER_ID,
      aud: "channel_t",
      exp: 9_999_999_999,
      iat: 1,
      nonce: "n"
    } as never
  } as never);
  vi.spyOn(lineApi, "verifyLineAccessTokenUser").mockResolvedValue({ ok: true } as never);
  vi.spyOn(lineApi, "verifyLineFriendship").mockResolvedValue({ ok: true, friendFlag: true } as never);
};

const baseEnv = (db: ReturnType<typeof createMigratedSqliteD1>) =>
  ({
    DB: db as unknown as D1Database,
    LINE_CHANNEL_ID: "channel_t"
  } as Record<string, unknown>);

const authedGetHeaders = {
  "Sec-Fetch-Site": "same-origin",
  // Cloudflare sets CF-Connecting-IP on every real ingress request; the customer
  // auth gate fails closed without it.
  "CF-Connecting-IP": "203.0.113.10",
  "X-LINE-IdToken": "id",
  "X-LINE-AccessToken": "access",
  "X-LINE-Nonce": "n"
} as const;

describe("GET /api/public/my-reservations", () => {
  beforeEach(() => {
    stubLineApi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns upcoming reservations with the permanently-closed requestable contract", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      const start = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      const end = new Date(Date.now() + 49 * 60 * 60 * 1000).toISOString();
      seedReservation(d1, { startAt: start, endAt: end });
      seedLegacyPendingChangeRequest(d1);
      const app = createApp();
      const response = await app.request(
        new Request("https://reservation.test/api/public/my-reservations", {
          method: "GET",
          headers: authedGetHeaders
        }),
        {},
        baseEnv(d1)
      );
      expect(response.status).toBe(200);
      const json = (await response.json()) as {
        ok: boolean;
        reservations: Array<{
          id: string;
          pendingChangeRequest: unknown;
          historyCount: number;
          requestable: {
            cancel: { allowed: boolean; reason?: string };
            reschedule: { allowed: boolean; reason?: string };
          };
        }>;
      };
      expect(json.ok).toBe(true);
      expect(json.reservations).toHaveLength(1);
      const row = json.reservations[0];
      expect(row?.id).toBe("reservation_t");
      // 機能廃止後の固定契約: stale pending 行があっても一覧には出さない。
      expect(row?.pendingChangeRequest).toBeNull();
      expect(row?.historyCount).toBe(0);
      expect(row?.requestable.cancel.allowed).toBe(false);
      expect(row?.requestable.cancel.reason).toBe("cancel_requests_closed");
      expect(row?.requestable.reschedule.allowed).toBe(false);
      expect(row?.requestable.reschedule.reason).toBe("reschedule_requests_closed");
    } finally {
      d1.sqlite.close();
    }
  });

  it.each(["phone_admin", "admin"])("shows existing unassigned %s bookings only through the authenticated customer link", async (source) => {
    const d1 = createMigratedSqliteD1();
    try {
      const start = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      const end = new Date(Date.now() + 49 * 60 * 60 * 1000).toISOString();
      seedReservation(d1, { startAt: start, endAt: end });
      d1.sqlite.prepare("UPDATE reservations SET source = ?, line_identity_id = NULL").run(source);
      d1.sqlite.exec(`
        INSERT INTO store_settings (store_id, max_active_reservations_per_customer) VALUES ('store_t', 50);
        INSERT INTO customers (id, display_name, phone_hash) VALUES ('other_customer', 'Other', 'ph');
        INSERT INTO line_identities (id, customer_id, channel_id, line_user_id)
        VALUES ('other_identity', 'customer_t', 'channel_t', 'other_line_user');
      `);
      for (const [id, customerId, identityId, bookingSource, status, endsAt] of [
        ["other_customer_booking", "other_customer", null, source, "confirmed", end],
        ["other_identity_booking", "customer_t", "other_identity", source, "confirmed", end],
        ["other_web_booking", "customer_t", "other_identity", "web_line", "confirmed", end],
        ["unassigned_web", "customer_t", null, "web_line", "confirmed", end],
        ["unassigned_import", "customer_t", null, "system_import", "confirmed", end],
        ["cancelled_booking", "customer_t", null, source, "cancelled_by_admin", end],
        ["past_booking", "customer_t", null, source, "confirmed", "2026-01-01T02:00:00.000Z"]
      ]) {
        d1.sqlite.prepare(`
          INSERT INTO reservations (id, store_id, service_id, customer_id, resource_id,
            line_identity_id, source, status, start_at, end_at, duration_minutes, idempotency_key)
          SELECT ?, store_id, service_id, ?, resource_id, ?, ?, ?, ?, ?, duration_minutes, ?
          FROM reservations WHERE id = 'reservation_t'
        `).run(id, customerId, identityId, bookingSource, status,
          id === "past_booking" ? "2026-01-01T01:00:00.000Z" : start, endsAt, id);
      }
      const response = await createApp().request(
        "/api/public/my-reservations?customerId=other_customer",
        { headers: authedGetHeaders }, baseEnv(d1)
      );
      expect(response.status).toBe(200);
      const body = await response.json() as { reservations: Array<{ id: string }> };
      expect(body.reservations.map(row => row.id)).toEqual(["reservation_t"]);
    } finally {
      d1.sqlite.close();
    }
  });

  it("returns 401 when LIFF tokens are missing", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      const app = createApp();
      const response = await app.request(
        new Request("https://reservation.test/api/public/my-reservations", {
          method: "GET",
          headers: { "Sec-Fetch-Site": "same-origin" }
        }),
        {},
        baseEnv(d1)
      );
      expect(response.status).toBe(401);
      const json = (await response.json()) as { reason: string };
      expect(json.reason).toBe("missing_tokens");
    } finally {
      d1.sqlite.close();
    }
  });
});

describe("retired change-request routes return 404 and write nothing", () => {
  beforeEach(() => {
    stubLineApi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const countRows = (d1: ReturnType<typeof createMigratedSqliteD1>) => ({
    changeRequests: (
      d1.sqlite.prepare("SELECT COUNT(*) AS n FROM reservation_change_requests").get() as { n: number }
    ).n,
    notificationJobs: (
      d1.sqlite.prepare("SELECT COUNT(*) AS n FROM notification_jobs").get() as { n: number }
    ).n,
    auditLogs: (d1.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs").get() as { n: number }).n
  });

  const RETIRED_ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
    {
      method: "POST",
      path: "/api/public/change-requests",
      body: {
        reservationId: "reservation_t",
        type: "cancel",
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
        idToken: "id",
        lineAccessToken: "access",
        nonce: "n"
      }
    },
    {
      method: "POST",
      path: "/api/public/change-requests/11111111-1111-4111-8111-111111111111/withdraw",
      body: {
        idempotencyKey: "22222222-2222-4222-8222-222222222222",
        idToken: "id",
        lineAccessToken: "access",
        nonce: "n"
      }
    },
    { method: "GET", path: "/api/public/reschedule-availability?reservationId=reservation_t&date=2026-08-10" },
    { method: "GET", path: "/api/admin/change-requests" },
    { method: "GET", path: "/api/admin/change-requests/history" },
    {
      method: "POST",
      path: "/api/admin/change-requests/11111111-1111-4111-8111-111111111111/approve",
      body: { idempotencyKey: "33333333-3333-4333-8333-333333333333" }
    },
    {
      method: "POST",
      path: "/api/admin/change-requests/11111111-1111-4111-8111-111111111111/reject",
      body: { idempotencyKey: "44444444-4444-4444-8444-444444444444", decisionNote: "x" }
    }
  ];

  for (const route of RETIRED_ROUTES) {
    it(`${route.method} ${route.path.split("?")[0]} -> 404`, async () => {
      const d1 = createMigratedSqliteD1();
      try {
        seedReservation(d1);
        const before = countRows(d1);
        const app = createApp();
        const response = await app.request(
          new Request(`https://reservation.test${route.path}`, {
            method: route.method,
            headers: {
              "Content-Type": "application/json",
              "Sec-Fetch-Site": "same-origin",
              "CF-Connecting-IP": "203.0.113.10",
              "X-LINE-IdToken": "id",
              "X-LINE-AccessToken": "access",
              "X-LINE-Nonce": "n"
            },
            ...(route.body ? { body: JSON.stringify(route.body) } : {})
          }),
          {},
          baseEnv(d1)
        );
        expect(response.status).toBe(404);
        expect(countRows(d1)).toEqual(before);
      } finally {
        d1.sqlite.close();
      }
    });
  }
});
