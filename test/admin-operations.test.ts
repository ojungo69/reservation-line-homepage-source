import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminUser } from "../src/admin/access";
import { cancelAdminExternalBlock, createAdminExternalBlock } from "../src/admin/external-blocks";
import { getAdminReservationDetail } from "../src/admin/operations";
import { hashRateLimitKey } from "../src/auth/reservation-gate";
import { createApp } from "../src/app";
import worker from "../src/index";
import type { WorkerBindings } from "../src/bindings";
import { ADMIN_SPA_CSP } from "../src/security-headers";
import { createAccessJwksFetchMock, createAccessJwtFixture as createAccessJwtFixtureBase, requestUrl, insertAdminUser as insertAdminUserHelper, grantCustomerTabGate, type AdminRole } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-operations-aud";
const ADMIN_EMAIL = "owner@example.com";
const ADMIN_ACCESS_SUBJECT = "access-subject-admin-operations";

const createAccessJwtFixture = () =>
  createAccessJwtFixtureBase({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: "admin-operations-key-1",
    claims: { email: ADMIN_EMAIL, sub: ADMIN_ACCESS_SUBJECT }
  });

const createFetchMock = (jwk: Parameters<typeof createAccessJwksFetchMock>[1]) =>
  createAccessJwksFetchMock(TEAM_DOMAIN, jwk);

const createThrowingDb = (): D1Database =>
  ({
    prepare: vi.fn(() => {
      throw new Error("forced admin dashboard database failure");
    })
  }) as unknown as D1Database;

const insertAdminUser = (db: SqliteD1Database, role: AdminRole = "owner") => {
  insertAdminUserHelper(db, {
    id: "admin_operations_owner_1",
    email: ADMIN_EMAIL,
    accessSubject: ADMIN_ACCESS_SUBJECT,
    role,
    updatedAt: "2026-05-09T00:00:00.000Z",
  });
  // spec 008 の顧客タブゲートは staff にだけ効く。このファイルのテストは店舗スコープと
  // role を見るものなので、承認済みの状態から始める (ゲート自体は
  // test/admin-customer-gate.test.ts で検証する)。
  if (role === "staff") grantCustomerTabGate(db, "admin_operations_owner_1");
};

const baseEnv = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db
});

const adminRequest = (
  db: SqliteD1Database,
  token: string,
  path: string,
  init: RequestInit = {}
) => {
  const app = createApp();
  const headers = new Headers(init.headers);
  headers.set("Cf-Access-Jwt-Assertion", token);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return app.request(path, { ...init, headers }, baseEnv(db));
};

const createExternalBlockCancelRaceDb = (db: SqliteD1Database, externalBlockId: string, updatedAt: string) =>
  ({
    prepare: (sql: string) => db.prepare(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      db.sqlite
        .prepare(
          `
            UPDATE external_blocks
            SET status = 'cancelled',
                updated_at = ?
            WHERE id = ?
          `
        )
        .run(updatedAt, externalBlockId);
      return db.batch(statements);
    }
  }) as unknown as D1Database;

const todayJstSlot = () => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const year = Number(value("year"));
  const month = Number(value("month"));
  const day = Number(value("day"));
  const startMs = Date.UTC(year, month - 1, day, 1, 0, 0, 0);
  return {
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(startMs + 60 * 60 * 1000).toISOString()
  };
};

const insertTodayReservation = (db: SqliteD1Database) => {
  const slot = todayJstSlot();
  db.sqlite
    .prepare(
      `
        INSERT INTO customers (
          id,
          display_name,
          display_name_kana,
          phone_normalized,
          phone_hash,
          block_status,
          updated_at
        ) VALUES ('customer_admin_ops_1', '運用 顧客', 'ウンヨウ コキャク', '0759999999', 'phone_hash_admin_ops_1', 'active', '2026-05-09T00:00:00.000Z')
      `
    )
    .run();
  db.sqlite
    .prepare(
      `
        INSERT INTO line_identities (
          id,
          customer_id,
          channel_id,
          line_user_id,
          friend_flag,
          official_friend_status,
          updated_at
        ) VALUES (
          'line_identity_admin_ops_1',
          'customer_admin_ops_1',
          'line_channel_admin_ops_1',
          'line_user_internal_not_for_staff',
          1,
          'friend',
          '2026-05-09T00:00:00.000Z'
        )
      `
    )
    .run();
  db.sqlite
    .prepare(
      `
        INSERT INTO reservations (
          id,
          store_id,
          service_id,
          customer_id,
          resource_id,
          source,
          status,
          start_at,
          end_at,
          duration_minutes,
          created_by,
          updated_by,
          idempotency_key,
          google_sync_state,
          version,
          updated_at
        ) VALUES (
          'reservation_admin_ops_today_1',
          'kyoto',
          'service_kyoto_default_60',
          'customer_admin_ops_1',
          'resource_kyoto_calendar',
          'phone_admin',
          'confirmed',
          ?,
          ?,
          60,
          'admin_operations_owner_1',
          'admin_operations_owner_1',
          'admin_ops_reservation_fixture',
          'pending',
          1,
          '2026-05-09T00:00:00.000Z'
        )
      `
    )
    .run(slot.startAt, slot.endAt);
  db.sqlite
    .prepare(
      `
        INSERT INTO customer_visits (
          id,
          customer_id,
          reservation_id,
          store_id,
          visited_at,
          visit_source,
          status,
          recorded_by
        ) VALUES (
          'visit_admin_ops_1',
          'customer_admin_ops_1',
          'reservation_admin_ops_today_1',
          'kyoto',
          ?,
          'reservation_completed',
          'valid',
          'admin_operations_owner_1'
        )
      `
    )
    .run(slot.endAt);
};

const stubCtx = (): ExecutionContext =>
  ({
    waitUntil: () => undefined,
    passThroughOnException: () => undefined
  }) as unknown as ExecutionContext;

const stubAssetsBinding = () =>
  ({
    fetch: vi.fn(async (input: RequestInfo | URL) => {
      // serveAdminSpa fetches /admin-app/index.html from this binding and
      // requires the admin-spa-sentinel marker; return a minimal SPA shell so
      // authenticated /admin requests resolve to the SPA (200) in tests.
      if (requestUrl(input).includes("/admin-app/index.html")) {
        return new Response(
          '<!doctype html><html lang="ja"><head></head><body><div id="root"></div><!-- admin-spa-sentinel --></body></html>',
          { status: 200, headers: { "Content-Type": "text/html; charset=UTF-8" } }
        );
      }
      return new Response("public asset stub", { status: 200 });
    })
  }) as unknown as Fetcher;

const workerFetch = (url: string, headers: Record<string, string>, db: SqliteD1Database) =>
  worker.fetch(
    new Request(url, { headers }),
    { ...baseEnv(db), ASSETS: stubAssetsBinding() } as unknown as WorkerBindings,
    stubCtx()
  );

describe("admin operations API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps private cache headers on unexpected admin dashboard errors", async () => {
    const app = createApp();
    const access = createAccessJwtFixture();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      const response = await app.request(
        "/admin",
        {
          headers: {
            "Cf-Access-Jwt-Assertion": access.token
          }
        },
        {
          ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
          ACCESS_AUD,
          DB: createThrowingDb()
        }
      );

      expect(response.status).toBe(500);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      const csp500 = response.headers.get("content-security-policy") ?? "";
      expect(csp500).toContain("default-src 'none'");
      expect(csp500).not.toContain("script-src 'self'");
      expect(csp500).not.toContain("connect-src 'self'");
      expect(await response.text()).toContain("Internal Server Error");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("keeps voided visits in the customer and reservation detail payloads", async () => {
    // 表示側はグレーの「無効」バッジで見分ける。API が落とすと、訂正されたこと
    // 自体が画面から消えて追跡できなくなる。
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertTodayReservation(db);
      db.sqlite
        .prepare(
          `UPDATE customer_visits
           SET status = 'voided', voided_by = 'admin_operations_owner_1',
               voided_at = '2026-05-10T00:00:00.000Z', void_reason = 'reservation_corrected_to_no_show'
           WHERE id = 'visit_admin_ops_1'`
        )
        .run();

      const customerDetail = await adminRequest(db, access.token, "/api/admin/customers/customer_admin_ops_1");
      await expect(customerDetail.json()).resolves.toMatchObject({
        ok: true,
        customer: { visits: [{ id: "visit_admin_ops_1", status: "voided" }] }
      });

      const reservationDetail = await adminRequest(
        db,
        access.token,
        "/api/admin/reservations/reservation_admin_ops_today_1"
      );
      await expect(reservationDetail.json()).resolves.toMatchObject({
        ok: true,
        reservation: { visits: [{ id: "visit_admin_ops_1", status: "voided" }] }
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("orders mixed visit formats by their JST-normalized time", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertTodayReservation(db);
      db.sqlite
        .prepare(
          `UPDATE customer_visits
           SET visited_at = '2026-04-01T23:30:00.000Z'
           WHERE id = 'visit_admin_ops_1'`
        )
        .run();
      db.sqlite
        .prepare(
          `INSERT INTO customer_visits (
             id, customer_id, store_id, visited_at, visit_source, status, recorded_by
           ) VALUES (
             'visit_admin_ops_manual', 'customer_admin_ops_1', 'kyoto', '2026-04-02',
             'manual_import', 'valid', 'admin_operations_owner_1'
           )`
        )
        .run();

      const detail = await adminRequest(db, access.token, "/api/admin/customers/customer_admin_ops_1");
      expect(detail.status).toBe(200);
      const body = (await detail.json()) as {
        customer: { visits: Array<{ id: string; visitedAt: string }> };
      };
      expect(body.customer.visits.map(({ id, visitedAt }) => ({ id, visitedAt }))).toEqual([
        { id: "visit_admin_ops_1", visitedAt: "2026-04-01T23:30:00.000Z" },
        { id: "visit_admin_ops_manual", visitedAt: "2026-04-02" }
      ]);
    } finally {
      db.sqlite.close();
    }
  });

  // 来店履歴の記入者。`recorded_by` に入るのは 'system' か admin_users.id で、
  // そのままでは誰か分からない。本番では大半の管理ユーザーが staff_members に
  // 紐付いていないので、名前が引けない場合まで含めて空欄にならないことを見る。
  it("names who recorded each visit, falling back to the role when there is no staff name", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertTodayReservation(db);
      db.sqlite
        .prepare(
          `INSERT INTO staff_members (id, store_id, display_name, role)
           VALUES ('staff_kyoto_1', 'kyoto', '京都 花子', 'staff')`
        )
        .run();
      insertAdminUserHelper(db, {
        id: "admin_operations_staff_1",
        staffMemberId: "staff_kyoto_1",
        email: "staff-kyoto@example.com",
        accessSubject: "access-subject-staff-kyoto",
        role: "staff"
      });
      const insertVisit = db.sqlite.prepare(
        `INSERT INTO customer_visits (id, customer_id, store_id, visited_at, visit_source, status, recorded_by)
         VALUES (?, 'customer_admin_ops_1', 'kyoto', ?, 'manual_import', 'valid', ?)`
      );
      insertVisit.run("visit_by_staff", "2026-04-04T00:00:00.000Z", "admin_operations_staff_1");
      insertVisit.run("visit_by_owner", "2026-04-03T00:00:00.000Z", "admin_operations_owner_1");
      insertVisit.run("visit_by_cron", "2026-04-02T00:00:00.000Z", "system");
      // 退職などで admin_users から消えた記入者。来店行そのものは残る。
      insertVisit.run("visit_by_gone", "2026-04-01T00:00:00.000Z", "admin_deleted_1");

      const detail = await adminRequest(db, access.token, "/api/admin/customers/customer_admin_ops_1");
      const body = (await detail.json()) as {
        customer: { visits: Array<{ id: string; recordedBy: string }> };
      };
      const byId = new Map(body.customer.visits.map((visit) => [visit.id, visit.recordedBy]));
      expect(byId.get("visit_by_staff")).toBe("京都 花子");
      expect(byId.get("visit_by_owner")).toBe("オーナー");
      expect(byId.get("visit_by_cron")).toBe("自動完了");
      expect(byId.get("visit_by_gone")).toBe("不明");
    } finally {
      db.sqlite.close();
    }
  });

  // 予約詳細パネルの「これより前のぶんは顧客タブの来店履歴でご確認いただけます」の
  // 行き先。詳細が返すのは先頭 50 件だけなので、続きが引けないと案内が嘘になる。
  // ルート登録の取り違えで 404 になる事故があったので、ハンドラ直呼びではなく
  // HTTP 経由で到達性ごと見る。
  it("serves the rest of the visit history from the paged route", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertTodayReservation(db);
      const insertVisit = db.sqlite.prepare(
        `INSERT INTO customer_visits (id, customer_id, store_id, visited_at, visit_source, status, recorded_by)
         VALUES (?, 'customer_admin_ops_1', 'kyoto', ?, 'manual_import', 'valid', 'admin_operations_owner_1')`
      );
      // 55 行 + 予約由来の 1 行 = 56 行。1 ページ目 50 行、2 ページ目 6 行。
      for (let i = 0; i < 55; i += 1) {
        insertVisit.run(`visit_page_${i}`, `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`);
      }

      const first = await adminRequest(db, access.token, "/api/admin/customers/customer_admin_ops_1/visits");
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as {
        visits: Array<{ id: string }>;
        nextOffset: number | null;
      };
      expect(firstBody.visits).toHaveLength(50);
      expect(firstBody.nextOffset).toBe(50);

      const second = await adminRequest(
        db,
        access.token,
        "/api/admin/customers/customer_admin_ops_1/visits?offset=50"
      );
      const secondBody = (await second.json()) as {
        visits: Array<{ id: string }>;
        nextOffset: number | null;
      };
      expect(secondBody.visits).toHaveLength(6);
      expect(secondBody.nextOffset).toBeNull();
      // 2 ページで全件・重複なし。並び順が 2 経路でずれると行が落ちる。
      const ids = [...firstBody.visits, ...secondBody.visits].map((visit) => visit.id);
      expect(new Set(ids).size).toBe(56);

      const detail = await adminRequest(db, access.token, "/api/admin/customers/customer_admin_ops_1");
      const detailBody = (await detail.json()) as { customer: { visits: Array<{ id: string }> } };
      // 詳細の 1 ページ目とページングの 1 ページ目は同じ行・同じ順序であること。
      expect(detailBody.customer.visits.map((visit) => visit.id)).toEqual(
        firstBody.visits.map((visit) => visit.id)
      );
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects a nonsense offset instead of silently starting from zero", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertTodayReservation(db);
      const bad = await adminRequest(
        db,
        access.token,
        "/api/admin/customers/customer_admin_ops_1/visits?offset=-1"
      );
      expect(bad.status).toBe(400);
      const garbage = await adminRequest(
        db,
        access.token,
        "/api/admin/customers/customer_admin_ops_1/visits?offset=abc"
      );
      expect(garbage.status).toBe(400);
    } finally {
      db.sqlite.close();
    }
  });

  it("counts every valid visit for the heading, past the 50-row page and skipping voided rows", async () => {
    // 見出しの件数を表示中の行から数えると、50 行で打ち切られる分と無効化された
    // 行の分だけ実際より少なく出る。別の店舗の来店は staff に漏らさないので、
    // 件数のクエリも一覧と同じ店舗条件を通す。
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertTodayReservation(db);
      const insertVisit = db.sqlite.prepare(
        `INSERT INTO customer_visits (id, customer_id, store_id, visited_at, visit_source, status, recorded_by)
         VALUES (?, 'customer_admin_ops_1', 'kyoto', ?, 'manual_import', 'valid', 'admin_operations_owner_1')`
      );
      for (let i = 0; i < 60; i += 1) {
        insertVisit.run(`visit_page_${i}`, `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`);
      }
      db.sqlite
        .prepare(
          `UPDATE customer_visits
           SET status = 'voided', voided_by = 'admin_operations_owner_1',
               voided_at = '2026-05-10T00:00:00.000Z', void_reason = 'reservation_corrected_to_no_show'
           WHERE id = 'visit_admin_ops_1'`
        )
        .run();

      const detail = await adminRequest(db, access.token, "/api/admin/customers/customer_admin_ops_1");
      const body = (await detail.json()) as { customer: { validVisitCount: number; visits: unknown[] } };

      // 61 行あり 1 行が無効。ページは 50 行で打ち切られる。
      expect(body.customer.visits).toHaveLength(50);
      expect(body.customer.validVisitCount).toBe(60);
    } finally {
      db.sqlite.close();
    }
  });

  it("lists today reservations, reservation details, customer history, settings, and audit logs", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertTodayReservation(db);
      db.sqlite
        .prepare(
          `
            INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json, created_at)
            VALUES ('audit_admin_ops_1', 'staff', 'admin_operations_owner_1', 'admin_fixture_created', 'reservation', 'reservation_admin_ops_today_1', '{"internal":"owner_hidden"}', '2026-05-09T00:00:00.000Z')
          `
        )
        .run();

      const reservations = await adminRequest(db, access.token, "/api/admin/reservations?range=today");
      expect(reservations.status).toBe(200);
      await expect(reservations.json()).resolves.toMatchObject({
        ok: true,
        range: "today",
        reservations: [
          {
            id: "reservation_admin_ops_today_1",
            customerDisplayName: "運用 顧客",
            // Regression: this reservation is source=phone_admin with
            // line_identity_id=NULL, but the customer HAS a friend LINE
            // identity. LINE status is resolved per-customer, so the list
            // must report "friend" (not null / 不明).
            lineFriendStatus: "friend"
          }
        ]
      });

      const reservationDetail = await adminRequest(
        db,
        access.token,
        "/api/admin/reservations/reservation_admin_ops_today_1"
      );
      expect(reservationDetail.status).toBe(200);
      await expect(reservationDetail.json()).resolves.toMatchObject({
        ok: true,
        reservation: {
          id: "reservation_admin_ops_today_1",
          serviceIds: ["service_kyoto_default_60"],
          phoneNormalized: "0759999999",
          // Core regression (予約詳細パネル LINE 行): per-customer resolution
          // makes a phone-booked reservation show the linked customer's
          // friend status instead of 不明.
          lineFriendStatus: "friend",
          visits: [
            {
              id: "visit_admin_ops_1",
              status: "valid"
            }
          ]
        }
      });

      const customerDetail = await adminRequest(db, access.token, "/api/admin/customers/customer_admin_ops_1");
      expect(customerDetail.status).toBe(200);
      const customerDetailJson = await customerDetail.json();
      expect(customerDetailJson).toMatchObject({
        ok: true,
        customer: {
          id: "customer_admin_ops_1",
          // Owner sees the raw phone (staff masking is covered by the reservation
          // detail + customer search staff tests, which share maskPhoneTail).
          phoneNormalized: "0759999999",
          lineIdentities: [
            {
              id: "line_identity_admin_ops_1",
              officialFriendStatus: "friend"
            }
          ],
          visits: [
            {
              id: "visit_admin_ops_1"
            }
          ],
          reservations: [
            {
              id: "reservation_admin_ops_today_1",
              // 4th reservationSelect consumer (customer detail sub-list):
              // lineFriendStatus is also resolved per-customer here.
              lineFriendStatus: "friend"
            }
          ]
        }
      });
      expect(JSON.stringify(customerDetailJson)).not.toContain("line_user_internal_not_for_staff");
      expect(JSON.stringify(customerDetailJson)).not.toContain("lineUserId");

      db.sqlite
        .prepare("UPDATE services SET price_label = ?, price_amount = ?, combo_price_amount = ?, combo_with_prefix = ? WHERE id = 'service_kyoto_hair_removal_full_60'")
        .run("10,000円（税込）", 10_000, 8_000, "脱毛");
      db.sqlite
        .prepare("UPDATE services SET price_label = NULL WHERE id = 'service_kyoto_hair_removal_upper_focus_45'")
        .run();
      db.sqlite
        .prepare("INSERT INTO stores (id, name, timezone) VALUES ('store_without_settings', '設定なし店舗', 'Asia/Tokyo')")
        .run();
      const settings = await adminRequest(db, access.token, "/api/admin/settings");
      expect(settings.status).toBe(200);
      const settingsJson = await settings.json() as {
        settings: {
          stores: Array<{ id: string; maxActiveReservationsPerCustomer: number }>;
          services: Array<{ id: string; priceLabel: string | null; priceAmount: number | null; comboPriceAmount: number | null; comboWithPrefix: string | null; mensMenu: boolean }>;
        };
      };
      expect(settingsJson.settings.stores.length).toBeGreaterThanOrEqual(4);
      expect(
        settingsJson.settings.stores.find((store) => store.id === "store_without_settings")
          ?.maxActiveReservationsPerCustomer
      ).toBe(1);
      expect(settingsJson.settings.services.length).toBeGreaterThanOrEqual(4);
      expect(
        settingsJson.settings.services.find((service) => service.id === "service_kyoto_hair_removal_full_60")?.priceLabel
      ).toBe("10,000円（税込）");
      expect(
        settingsJson.settings.services.find((service) => service.id === "service_kyoto_hair_removal_upper_focus_45")?.priceLabel
      ).toBeNull();
      expect(settingsJson.settings.services.find((service) => service.id === "service_kyoto_hair_removal_full_60")).toMatchObject({
        priceAmount: 10_000,
        comboPriceAmount: 8_000,
        comboWithPrefix: "脱毛"
      });
      expect(settingsJson.settings.services.find((service) => service.id === "service_kyoto_hair_removal_upper_focus_45")).toMatchObject({
        priceAmount: null,
        comboPriceAmount: null,
        comboWithPrefix: null,
        mensMenu: false
      });
      expect(
        settingsJson.settings.services.find(
          (service) => service.id === "service_kyoto_mens_hair_removal_beard_30"
        )
      ).toMatchObject({ mensMenu: true });

      const audit = await adminRequest(db, access.token, "/api/admin/audit-logs");
      expect(audit.status).toBe(200);
      await expect(audit.json()).resolves.toMatchObject({
        ok: true,
        auditLogs: [
          {
            id: "audit_admin_ops_1",
            action: "admin_fixture_created",
            metadataJson: null
          }
        ]
      });

      // Validation tests
      const invalidActorType = await adminRequest(db, access.token, "/api/admin/audit-logs?actorType=invalid");
      expect(invalidActorType.status).toBe(400);
      await expect(invalidActorType.json()).resolves.toEqual({ ok: false, reason: "invalid_filter" });

      const invalidFrom = await adminRequest(db, access.token, "/api/admin/audit-logs?from=not-a-date");
      expect(invalidFrom.status).toBe(400);
      await expect(invalidFrom.json()).resolves.toEqual({ ok: false, reason: "invalid_filter" });

      const invalidTo = await adminRequest(db, access.token, "/api/admin/audit-logs?to=not-a-date");
      expect(invalidTo.status).toBe(400);
      await expect(invalidTo.json()).resolves.toEqual({ ok: false, reason: "invalid_filter" });

      const invalidDateRange = await adminRequest(db, access.token, "/api/admin/audit-logs?from=2026-05-10T00:00:00Z&to=2026-05-09T00:00:00Z");
      expect(invalidDateRange.status).toBe(400);
      await expect(invalidDateRange.json()).resolves.toEqual({ ok: false, reason: "invalid_filter" });

      // Regression guard: the admin activity UI (activity.tsx jstDateToIsoFrom)
      // sends `from` as a JST offset instant (...T00:00:00+09:00). Offset
      // forms MUST be accepted -- strict-Z-only validation would 400 every
      // start-date filter from the real client.
      const offsetFrom = await adminRequest(db, access.token, "/api/admin/audit-logs?from=2026-05-09T00:00:00%2B09:00");
      expect(offsetFrom.status).toBe(200);

      const malformedOffset = await adminRequest(db, access.token, "/api/admin/audit-logs?from=2026-05-09T00:00:00%2B9:00");
      expect(malformedOffset.status).toBe(400);
      await expect(malformedOffset.json()).resolves.toEqual({ ok: false, reason: "invalid_filter" });

      const invalidLimitPartial = await adminRequest(db, access.token, "/api/admin/audit-logs?limit=10abc");
      expect(invalidLimitPartial.status).toBe(400);
      await expect(invalidLimitPartial.json()).resolves.toEqual({ ok: false, reason: "invalid_filter" });

      const invalidLimitNegative = await adminRequest(db, access.token, "/api/admin/audit-logs?limit=-5");
      expect(invalidLimitNegative.status).toBe(400);
      await expect(invalidLimitNegative.json()).resolves.toEqual({ ok: false, reason: "invalid_filter" });

      const invalidLimitLarge = await adminRequest(db, access.token, "/api/admin/audit-logs?limit=500");
      expect(invalidLimitLarge.status).toBe(400);
      await expect(invalidLimitLarge.json()).resolves.toEqual({ ok: false, reason: "invalid_filter" });

      const overbudgetKeyword = "a".repeat(51);
      const invalidKeyword = await adminRequest(db, access.token, `/api/admin/audit-logs?keyword=${overbudgetKeyword}`);
      expect(invalidKeyword.status).toBe(400);
      await expect(invalidKeyword.json()).resolves.toEqual({ ok: false, reason: "invalid_filter" });

      const validFilter = await adminRequest(db, access.token, "/api/admin/audit-logs?actorType=staff&limit=50&keyword=test");
      expect(validFilter.status).toBe(200);
      await expect(validFilter.json()).resolves.toMatchObject({
        ok: true,
        auditLogs: expect.any(Array)
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns reservation service IDs in display order", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertTodayReservation(db);
      // display_order を挿入順・service_id 辞書順の両方と逆にし、応答順が
      // display_order 由来であることを一意に証明する（ORDER BY が消えても
      // 他の順序と偶然一致して通る、を防ぐ）。
      db.sqlite
        .prepare(
          `INSERT INTO reservation_services (
             reservation_id, service_id, display_order, name_snapshot, duration_minutes
           ) VALUES
             ('reservation_admin_ops_today_1', 'service_kyoto_default_60', 1, '60分', 60),
             ('reservation_admin_ops_today_1', 'service_kyoto_hair_removal_upper_focus_45', 0, '上半身', 45)`
        )
        .run();

      const response = await adminRequest(
        db,
        access.token,
        "/api/admin/reservations/reservation_admin_ops_today_1"
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        reservation: {
          serviceIds: [
            "service_kyoto_hair_removal_upper_focus_45",
            "service_kyoto_default_60"
          ]
        }
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("exposes reservationOrigin on the reservation detail", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      // Detail is fetched by id (range-independent), so fixed ISO timestamps keep
      // this assertion wall-clock independent.
      db.sqlite
        .prepare(
          `INSERT INTO customers (id, display_name, phone_normalized, phone_hash)
           VALUES ('cust_origin', '出所 客', '0700000055', 'hash_origin')`
        )
        .run();
      db.sqlite
        .prepare(
          `INSERT INTO reservations (
             id, store_id, service_id, customer_id, resource_id, source, status,
             start_at, end_at, duration_minutes, idempotency_key, reservation_origin
           ) VALUES (
             'res_origin', 'kyoto', 'service_kyoto_default_60', 'cust_origin',
             'resource_kyoto_calendar', 'phone_admin', 'confirmed',
             '2026-06-01T01:00:00.000Z', '2026-06-01T02:00:00.000Z', 65,
             'idem_origin', 'minimo'
           )`
        )
        .run();
      db.sqlite
        .prepare(
          `INSERT INTO reservation_services (reservation_id, service_id, display_order, name_snapshot, duration_minutes)
           VALUES ('res_origin', 'service_kyoto_default_60', 0, '60分', 60)`
        )
        .run();

      const reservationDetail = await adminRequest(
        db,
        access.token,
        "/api/admin/reservations/res_origin"
      );
      expect(reservationDetail.status).toBe(200);
      await expect(reservationDetail.json()).resolves.toMatchObject({
        ok: true,
        reservation: {
          id: "res_origin",
          reservationOrigin: "minimo",
        },
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("keeps audit metadata forbidden for staff and visible only to system_admin", async () => {
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    const dbStaff = createMigratedSqliteD1();
    try {
      insertAdminUser(dbStaff, "staff");
      const staffAudit = await adminRequest(dbStaff, access.token, "/api/admin/audit-logs");
      expect(staffAudit.status).toBe(403);
      await expect(staffAudit.json()).resolves.toEqual({
        ok: false,
        reason: "forbidden"
      });
    } finally {
      dbStaff.sqlite.close();
    }

    const dbSystemAdmin = createMigratedSqliteD1();
    try {
      insertAdminUser(dbSystemAdmin, "system_admin");
      dbSystemAdmin.sqlite
        .prepare(
          `
            INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json, created_at)
            VALUES ('audit_admin_ops_system_1', 'system', 'test', 'system_audit_fixture', 'reservation', 'reservation-test', '{"system":"visible"}', '2026-05-09T00:00:00.000Z')
          `
        )
        .run();

      const systemAudit = await adminRequest(dbSystemAdmin, access.token, "/api/admin/audit-logs");
      expect(systemAudit.status).toBe(200);
      await expect(systemAudit.json()).resolves.toMatchObject({
        ok: true,
        auditLogs: [
          {
            id: "audit_admin_ops_system_1",
            metadataJson: '{"system":"visible"}'
          }
        ]
      });
    } finally {
      dbSystemAdmin.sqlite.close();
    }
  });

  it("projects rejectionReason from reject audit rows without widening raw metadata exposure", async () => {
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    // 却下理由 projection の境界セット。projection 条件 (action + target_type) と
    // fail-soft (壊れた JSON / 非文字列 / 500字超) を同一応答内で固定する。
    const reason500 = "あ".repeat(500);
    const reason501 = "あ".repeat(501);
    const seedRejectionAuditRows = (db: SqliteD1Database) => {
      const insert = db.sqlite.prepare(
        `
          INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json, created_at)
          VALUES (?, 'staff', 'admin_operations_owner_1', ?, ?, 'reservation_rr_1', ?, ?)
        `
      );
      insert.run(
        "audit_rr_ok",
        "admin_reservation_reject",
        "reservation",
        JSON.stringify({ previousStatus: "pending_approval", nextStatus: "rejected", reason: "予定が重複したため" }),
        "2026-05-09T00:00:07.000Z"
      );
      insert.run("audit_rr_broken", "admin_reservation_reject", "reservation", "not-json{", "2026-05-09T00:00:06.000Z");
      insert.run("audit_rr_nonstring", "admin_reservation_reject", "reservation", '{"reason":42}', "2026-05-09T00:00:05.000Z");
      insert.run(
        "audit_rr_len500",
        "admin_reservation_reject",
        "reservation",
        JSON.stringify({ reason: reason500 }),
        "2026-05-09T00:00:04.000Z"
      );
      insert.run(
        "audit_rr_len501",
        "admin_reservation_reject",
        "reservation",
        JSON.stringify({ reason: reason501 }),
        "2026-05-09T00:00:03.000Z"
      );
      insert.run(
        "audit_rr_other_action",
        "admin_reservation_approved",
        "reservation",
        '{"reason":"unrelated"}',
        "2026-05-09T00:00:02.000Z"
      );
      insert.run(
        "audit_rr_other_target",
        "admin_reservation_reject",
        "customer",
        '{"reason":"wrong target"}',
        "2026-05-09T00:00:01.000Z"
      );
    };

    const dbOwner = createMigratedSqliteD1();
    try {
      insertAdminUser(dbOwner, "owner");
      seedRejectionAuditRows(dbOwner);

      const ownerAudit = await adminRequest(dbOwner, access.token, "/api/admin/audit-logs");
      expect(ownerAudit.status).toBe(200);
      const ownerJson = (await ownerAudit.json()) as {
        ok: boolean;
        auditLogs: Array<{ id: string; metadataJson: string | null; rejectionReason: string | null }>;
      };
      const byId = new Map(ownerJson.auditLogs.map((log) => [log.id, log]));

      // owner は理由が見える。ただし raw metadata は従来どおり null のまま。
      expect(byId.get("audit_rr_ok")).toMatchObject({
        rejectionReason: "予定が重複したため",
        metadataJson: null
      });
      // fail-soft: 壊れた行があっても 200 のまま、その行だけ null。
      expect(byId.get("audit_rr_broken")?.rejectionReason).toBeNull();
      expect(byId.get("audit_rr_nonstring")?.rejectionReason).toBeNull();
      // 長さ境界: 500字は表示、501字は null。
      expect(byId.get("audit_rr_len500")?.rejectionReason).toBe(reason500);
      expect(byId.get("audit_rr_len501")?.rejectionReason).toBeNull();
      // projection 条件外 (別 action / 別 target_type) には metadata の reason を漏らさない。
      expect(byId.get("audit_rr_other_action")?.rejectionReason).toBeNull();
      expect(byId.get("audit_rr_other_target")?.rejectionReason).toBeNull();
    } finally {
      dbOwner.sqlite.close();
    }

    // system_admin は raw metadata と projection の両方が見える。
    const dbSystemAdmin = createMigratedSqliteD1();
    try {
      insertAdminUser(dbSystemAdmin, "system_admin");
      seedRejectionAuditRows(dbSystemAdmin);

      const systemAudit = await adminRequest(dbSystemAdmin, access.token, "/api/admin/audit-logs");
      expect(systemAudit.status).toBe(200);
      const systemJson = (await systemAudit.json()) as {
        auditLogs: Array<{ id: string; metadataJson: string | null; rejectionReason: string | null }>;
      };
      const rejectRow = systemJson.auditLogs.find((log) => log.id === "audit_rr_ok");
      expect(rejectRow?.rejectionReason).toBe("予定が重複したため");
      expect(rejectRow?.metadataJson).toContain('"reason":"予定が重複したため"');
    } finally {
      dbSystemAdmin.sqlite.close();
    }
  });

  it("includes closures but excludes staff from GET /api/admin/settings for staff role", async () => {
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    const dbStaff = createMigratedSqliteD1();
    try {
      insertAdminUser(dbStaff, "staff");
      dbStaff.sqlite
        .prepare(`INSERT INTO staff_members (id, store_id, display_name, role) VALUES ('staff_ops_settings', 'kyoto', 'Staff Settings', 'staff')`)
        .run();
      dbStaff.sqlite
        .prepare(`UPDATE admin_users SET staff_member_id = 'staff_ops_settings' WHERE id = 'admin_operations_owner_1'`)
        .run();
      const staffSettings = await adminRequest(dbStaff, access.token, "/api/admin/settings");
      expect(staffSettings.status).toBe(200);
      const staffJson = await staffSettings.json() as Record<string, unknown>;
      expect(staffJson).toMatchObject({ ok: true });
      const settings = staffJson.settings as Record<string, unknown>;
      // Staff should get stores, resources, services, businessHours, closures
      expect(settings).toHaveProperty("stores");
      expect(settings).toHaveProperty("resources");
      expect(settings).toHaveProperty("services");
      expect(settings).toHaveProperty("businessHours");
      expect(settings).toHaveProperty("closures");
      // Staff must NOT get staff data
      expect(settings).not.toHaveProperty("staff");
    } finally {
      dbStaff.sqlite.close();
    }

    // Owner should still get the full snapshot including closures and staff
    const dbOwner = createMigratedSqliteD1();
    try {
      insertAdminUser(dbOwner, "owner");
      const ownerSettings = await adminRequest(dbOwner, access.token, "/api/admin/settings");
      expect(ownerSettings.status).toBe(200);
      const ownerJson = await ownerSettings.json() as Record<string, unknown>;
      const ownerSettingsObj = ownerJson.settings as Record<string, unknown>;
      expect(ownerSettingsObj).toHaveProperty("closures");
      expect(ownerSettingsObj).toHaveProperty("staff");
    } finally {
      dbOwner.sqlite.close();
    }
  });

  it("lets owner block and unblock customers with idempotency and audit logs", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertTodayReservation(db);

      const block = await adminRequest(db, access.token, "/api/admin/customers/customer_admin_ops_1/block", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: "admin-customer-block-1",
          reason: "迷惑行為"
        })
      });
      expect(block.status).toBe(200);
      await expect(block.json()).resolves.toMatchObject({
        ok: true,
        customerId: "customer_admin_ops_1",
        blockStatus: "blocked",
        replayed: false
      });

      const blockReplay = await adminRequest(db, access.token, "/api/admin/customers/customer_admin_ops_1/block", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: "admin-customer-block-1",
          reason: "迷惑行為"
        })
      });
      expect(blockReplay.status).toBe(200);
      await expect(blockReplay.json()).resolves.toMatchObject({
        ok: true,
        customerId: "customer_admin_ops_1",
        blockStatus: "blocked",
        replayed: true
      });

      const blockedDetail = await adminRequest(db, access.token, "/api/admin/customers/customer_admin_ops_1");
      await expect(blockedDetail.json()).resolves.toMatchObject({
        ok: true,
        customer: {
          id: "customer_admin_ops_1",
          blockStatus: "blocked"
        }
      });

      const unblock = await adminRequest(db, access.token, "/api/admin/customers/customer_admin_ops_1/unblock", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: "admin-customer-unblock-1"
        })
      });
      expect(unblock.status).toBe(200);
      await expect(unblock.json()).resolves.toMatchObject({
        ok: true,
        customerId: "customer_admin_ops_1",
        blockStatus: "active",
        replayed: false
      });

      const state = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT block_status FROM customers WHERE id = 'customer_admin_ops_1') AS blockStatus,
              (SELECT COUNT(*) FROM audit_logs WHERE action = 'admin_customer_blocked') AS blockAuditCount,
              (SELECT COUNT(*) FROM audit_logs WHERE action = 'admin_customer_unblocked') AS unblockAuditCount
          `
        )
        .get() as { blockStatus: string; blockAuditCount: number; unblockAuditCount: number };
      expect(state).toEqual({
        blockStatus: "active",
        blockAuditCount: 1,
        unblockAuditCount: 1
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("forbids staff from changing customer block status", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "staff");
      insertTodayReservation(db);

      const response = await adminRequest(db, access.token, "/api/admin/customers/customer_admin_ops_1/block", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: "staff-customer-block-forbidden-1",
          reason: "staff should not block"
        })
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "forbidden"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("forbids staff from creating external blocks via HTTP", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "staff");

      const response = await adminRequest(db, access.token, "/api/admin/external-blocks", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: "staff-external-block-create-forbidden-1",
          storeId: "kyoto",
          resourceId: "resource_kyoto_calendar",
          startAt: "2099-08-01T01:00:00.000Z",
          endAt: "2099-08-01T02:00:00.000Z",
          title: "店内作業"
        })
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "forbidden"
      });

      const blockCount = db.sqlite
        .prepare(`SELECT COUNT(*) AS count FROM external_blocks`)
        .get() as { count: number };
      expect(blockCount.count).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("forbids staff from cancelling external blocks via HTTP", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "owner");
      const ownerCreate = await adminRequest(db, access.token, "/api/admin/external-blocks", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: "owner-create-for-staff-cancel-1",
          storeId: "kyoto",
          resourceId: "resource_kyoto_calendar",
          startAt: "2099-08-02T01:00:00.000Z",
          endAt: "2099-08-02T02:00:00.000Z",
          title: "店内作業"
        })
      });
      expect(ownerCreate.status).toBe(201);
      const ownerCreateJson = await ownerCreate.json() as { externalBlockId: string };

      db.sqlite.prepare(`DELETE FROM admin_users`).run();
      insertAdminUser(db, "staff");

      const cancel = await adminRequest(
        db,
        access.token,
        `/api/admin/external-blocks/${ownerCreateJson.externalBlockId}/cancel`,
        {
          method: "POST",
          body: JSON.stringify({
            idempotencyKey: "staff-external-block-cancel-forbidden-1",
            reason: "staff should not cancel"
          })
        }
      );
      expect(cancel.status).toBe(403);
      await expect(cancel.json()).resolves.toEqual({
        ok: false,
        reason: "forbidden"
      });

      const blockStatus = db.sqlite
        .prepare(`SELECT status FROM external_blocks WHERE id = ?`)
        .get(ownerCreateJson.externalBlockId) as { status: string };
      expect(blockStatus.status).toBe("active");
    } finally {
      db.sqlite.close();
    }
  });

  it("lets admins create and cancel D1 external blocks with locks, Google jobs, and audit logs", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const body = {
        idempotencyKey: "admin-external-block-create-1",
        storeId: "kyoto",
        resourceId: "resource_kyoto_calendar",
        startAt: "2099-06-01T01:00:00.000Z",
        endAt: "2099-06-01T02:00:00.000Z",
        title: "店内作業"
      };

      const create = await adminRequest(db, access.token, "/api/admin/external-blocks", {
        method: "POST",
        body: JSON.stringify(body)
      });
      expect(create.status).toBe(201);
      const createJson = await create.json() as {
        ok: true;
        externalBlockId: string;
        status: string;
        replayed: boolean;
      };
      expect(createJson).toMatchObject({
        ok: true,
        status: "active",
        replayed: false
      });

      const replay = await adminRequest(db, access.token, "/api/admin/external-blocks", {
        method: "POST",
        body: JSON.stringify(body)
      });
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toMatchObject({
        ok: true,
        externalBlockId: createJson.externalBlockId,
        replayed: true
      });

      const createdState = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT COUNT(*) FROM external_blocks WHERE id = ? AND source = 'admin_block' AND status = 'active') AS blockCount,
              (SELECT COUNT(*) FROM slot_locks WHERE owner_id = ? AND owner_type = 'external_block') AS lockCount,
              (SELECT COUNT(*) FROM calendar_sync_jobs WHERE owner_id = ? AND owner_type = 'external_block' AND google_action = 'upsert') AS upsertJobCount,
              (SELECT COUNT(*) FROM audit_logs WHERE target_id = ? AND action = 'admin_external_block_created') AS auditCount
          `
        )
        .get(
          createJson.externalBlockId,
          createJson.externalBlockId,
          createJson.externalBlockId,
          createJson.externalBlockId
        ) as { blockCount: number; lockCount: number; upsertJobCount: number; auditCount: number };
      expect(createdState).toEqual({
        blockCount: 1,
        lockCount: 12,
        upsertJobCount: 1,
        auditCount: 1
      });

      const blocks = await adminRequest(db, access.token, "/api/admin/external-blocks");
      expect(blocks.status).toBe(200);
      await expect(blocks.json()).resolves.toMatchObject({
        ok: true,
        externalBlocks: [
          {
            id: createJson.externalBlockId,
            status: "active",
            titleSnapshot: "店内作業"
          }
        ]
      });

      const cancel = await adminRequest(
        db,
        access.token,
        `/api/admin/external-blocks/${createJson.externalBlockId}/cancel`,
        {
          method: "POST",
          body: JSON.stringify({
            idempotencyKey: "admin-external-block-cancel-1",
            reason: "予定変更"
          })
        }
      );
      expect(cancel.status).toBe(200);
      await expect(cancel.json()).resolves.toMatchObject({
        ok: true,
        externalBlockId: createJson.externalBlockId,
        status: "cancelled",
        replayed: false
      });

      const cancelReplay = await adminRequest(
        db,
        access.token,
        `/api/admin/external-blocks/${createJson.externalBlockId}/cancel`,
        {
          method: "POST",
          body: JSON.stringify({
            idempotencyKey: "admin-external-block-cancel-1",
            reason: "予定変更"
          })
        }
      );
      expect(cancelReplay.status).toBe(200);
      await expect(cancelReplay.json()).resolves.toMatchObject({
        ok: true,
        externalBlockId: createJson.externalBlockId,
        status: "cancelled",
        replayed: true
      });

      const cancelledState = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT COUNT(*) FROM slot_locks WHERE owner_id = ?) AS lockCount,
              (SELECT COUNT(*) FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'delete') AS deleteJobCount,
              (SELECT COUNT(*) FROM audit_logs WHERE target_id = ? AND action = 'admin_external_block_cancelled') AS auditCount
          `
        )
        .get(createJson.externalBlockId, createJson.externalBlockId, createJson.externalBlockId) as {
          lockCount: number;
          deleteJobCount: number;
          auditCount: number;
        };
      expect(cancelledState).toEqual({
        lockCount: 0,
        deleteJobCount: 1,
        auditCount: 1
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("does not release external-block locks when cancellation loses a same-timestamp active-status transition", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUser(db);
    try {
      const raceTimestamp = "2099-06-02T00:00:00.000Z";
      const admin = {
        id: "admin_operations_owner_1",
        email: ADMIN_EMAIL,
        role: "owner" as const,
        staff_member_id: null,
      store_id: null
      };
      const created = await createAdminExternalBlock({
        db: db as unknown as D1Database,
        admin,
        request: {
          idempotencyKey: "admin-external-block-create-race-1",
          storeId: "kyoto",
          resourceId: "resource_kyoto_calendar",
          startAt: "2099-06-02T01:00:00.000Z",
          endAt: "2099-06-02T02:00:00.000Z",
          title: "競合テスト"
        }
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        throw new Error("test setup failed");
      }

      const result = await cancelAdminExternalBlock({
        db: createExternalBlockCancelRaceDb(db, created.externalBlockId, raceTimestamp),
        admin,
        externalBlockId: created.externalBlockId,
        request: {
          idempotencyKey: "admin-external-block-cancel-race-1",
          reason: "競合"
        },
        now: () => Date.parse(raceTimestamp)
      });

      expect(result).toEqual({
        ok: false,
        reason: "invalid_transition"
      });
      const state = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT COUNT(*) FROM slot_locks WHERE owner_id = ?) AS lockCount,
              (SELECT COUNT(*) FROM slot_lock_history WHERE old_owner_id = ? AND action = 'released') AS historyCount,
              (SELECT COUNT(*) FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'delete') AS deleteJobCount,
              (SELECT COUNT(*) FROM audit_logs WHERE target_id = ? AND action = 'admin_external_block_cancelled') AS auditCount,
              (SELECT COUNT(*) FROM idempotency_keys WHERE idempotency_key = 'admin-external-block-cancel-race-1') AS idempotencyCount
          `
        )
        .get(
          created.externalBlockId,
          created.externalBlockId,
          created.externalBlockId,
          created.externalBlockId
        ) as {
          lockCount: number;
          historyCount: number;
          deleteJobCount: number;
          auditCount: number;
          idempotencyCount: number;
        };
      expect(state).toEqual({
        lockCount: 12,
        historyCount: 0,
        deleteJobCount: 0,
        auditCount: 0,
        idempotencyCount: 0
      });
    } finally {
      db.sqlite.close();
    }
  });

  it.each([
    {
      name: "redirects admin host root (/) to /admin (301) at the worker entrypoint",
      url: "https://admin.example.invalid/",
      headers: { host: "admin.example.invalid" },
      expectedLocation: "/admin"
    },
    {
      name: "redirects admin host static asset path to /admin (entrypoint bypasses ASSETS)",
      url: "https://admin.example.invalid/styles.css",
      headers: { host: "admin.example.invalid" },
      expectedLocation: "/admin"
    },
    {
      name: "redirects admin host public reservation API to /admin (301)",
      url: "https://admin.example.invalid/api/public/reservation-options",
      headers: { host: "admin.example.invalid" },
      expectedLocation: "/admin"
    },
    {
      name: "preserves query string when redirecting admin host root",
      url: "https://admin.example.invalid/?date=2026-05-15",
      headers: { host: "admin.example.invalid" },
      expectedLocation: "/admin?date=2026-05-15"
    },
    {
      name: "strips port from Host header before admin-host match",
      url: "https://admin.example.invalid/",
      headers: { host: "admin.example.invalid:443" },
      expectedLocation: "/admin"
    }
  ])("$name", async ({ url, headers, expectedLocation }) => {
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    const response = await workerFetch(url, headers, createMigratedSqliteD1());
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(expectedLocation);
  });

  it("redirect response carries security headers (CSP/X-Frame-Options/etc)", async () => {
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    const response = await workerFetch(
      "https://admin.example.invalid/",
      { host: "admin.example.invalid" },
      createMigratedSqliteD1()
    );
    expect(response.headers.get("content-security-policy") ?? "").toContain("default-src 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains"
    );
  });

  it("does NOT redirect admin host /admin (passes through to Hono)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "owner");
      const response = await workerFetch(
        "https://admin.example.invalid/admin",
        { host: "admin.example.invalid", "Cf-Access-Jwt-Assertion": access.token },
        db
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it("routes /admin/ (trailing slash) to Hono not ASSETS (no SPA-fallback leak)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "owner");
      const response = await workerFetch(
        "https://admin.example.invalid/admin/",
        { host: "admin.example.invalid", "Cf-Access-Jwt-Assertion": access.token },
        db
      );
      // Hono returns 404 JSON for the unknown /admin/ path (not the public reservation HTML
      // SPA fallback). Either 200 (if Hono normalizes) or 404 (JSON) is acceptable — what
      // matters is the response is NOT text/html with public reservation markup.
      const contentType = response.headers.get("content-type") ?? "";
      const body = response.status === 200 ? await response.text() : "";
      expect(body).not.toContain("ExampleStudio 予約");
      expect(contentType).not.toMatch(/text\/html.*reservation/i);
    } finally {
      db.sqlite.close();
    }
  });

  it("does NOT redirect non-admin host (workers.dev keeps serving /api/health)", async () => {
    const response = await workerFetch(
      "https://reservation-line-homepage-production.jurarawww.workers.dev/api/health",
      { host: "reservation-line-homepage-production.jurarawww.workers.dev" },
      createMigratedSqliteD1()
    );
    expect(response.status).toBe(200);
  });

});

describe("admin SPA serving at canonical /admin", () => {
  it("serves the React SPA for an authenticated admin (200 + sentinel + SPA CSP + no-store)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      const response = await workerFetch(
        "https://admin.example.invalid/admin",
        { host: "admin.example.invalid", "Cf-Access-Jwt-Assertion": access.token },
        db
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("admin-spa-sentinel");
      const csp = response.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("https://static.cloudflareinsights.com/beacon.min.js");
      expect(csp).toMatch(/'nonce-[0-9a-f]{32}'/);
      expect(csp.replace(/ 'nonce-[0-9a-f]{32}'/, "")).toBe(ADMIN_SPA_CSP);
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally {
      db.sqlite.close();
    }
  });

  it("serves the SPA shell for an authenticated deep link (/admin/reservations)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      const response = await workerFetch(
        "https://admin.example.invalid/admin/reservations",
        { host: "admin.example.invalid", "Cf-Access-Jwt-Assertion": access.token },
        db
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("admin-spa-sentinel");
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 403 (no SPA leak) for an unauthenticated /admin request", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      const response = await workerFetch(
        "https://admin.example.invalid/admin",
        { host: "admin.example.invalid" },
        db
      );
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("admin-spa-sentinel");
    } finally {
      db.sqlite.close();
    }
  });

  it("404s the retired /admin-next alias on the admin host (root and sub-paths)", async () => {
    // Phase 5 retired the transitional /admin-next → /admin 301 alias: the path
    // now 404s. An explicit 404 (not an ASSETS fallthrough) is required because
    // the ASSETS binding uses single-page-application not_found_handling.
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      const root = await workerFetch(
        "https://admin.example.invalid/admin-next",
        { host: "admin.example.invalid", "Cf-Access-Jwt-Assertion": access.token },
        db
      );
      expect(root.status).toBe(404);

      const deep = await workerFetch(
        "https://admin.example.invalid/admin-next/reservations?store=1",
        { host: "admin.example.invalid", "Cf-Access-Jwt-Assertion": access.token },
        db
      );
      expect(deep.status).toBe(404);

      // Encoded alias variants must 404 too — the entrypoint decodes each well-formed
      // percent triplet and matches "/admin-next" at a path/query/fragment boundary, so
      // encoded slash (%2F), encoded 'a' (%61), trailing malformed escape, and encoded
      // query/fragment delimiters (%3F, %23) all 404 instead of slipping into the
      // SPA-fallback ASSETS handler.
      for (const encoded of [
        "/admin-next%2Freservations",
        "/%61dmin-next",
        "/admin-next%2Freservations%",
        "/admin-next%3Fstore=1",
        "/%61dmin-next%23old",
      ]) {
        const response = await workerFetch(
          `https://admin.example.invalid${encoded}`,
          { host: "admin.example.invalid", "Cf-Access-Jwt-Assertion": access.token },
          db
        );
        expect(response.status).toBe(404);
      }

      // Boundary check must NOT over-match a distinct path that merely shares the
      // prefix: /admin-nextfoo is not the retired alias, so it is not 404'd by the
      // alias block (on the admin host it falls through to the operator-host redirect).
      const lookAlike = await workerFetch(
        "https://admin.example.invalid/admin-nextfoo",
        { host: "admin.example.invalid", "Cf-Access-Jwt-Assertion": access.token },
        db
      );
      expect(lookAlike.status).not.toBe(404);
    } finally {
      db.sqlite.close();
    }
  });

  it("404s /admin-next on a public host too — no customer SPA leak (prod + non-prod, incl. encoded)", async () => {
    // Public host: the explicit entrypoint 404 decodes the path once (catching
    // encoded aliases) and runs before the host split; production also has the
    // reverse guard for the literal form. The single-page-application ASSETS
    // fallback must NOT serve the customer shell at the retired alias.
    const host = "reservation-line-homepage-production.jurarawww.workers.dev";
    const call = (path: string, env: Record<string, unknown>) =>
      worker.fetch(
        new Request(`https://${host}${path}`, { headers: { host } }),
        { ...env, ASSETS: stubAssetsBinding() } as unknown as WorkerBindings,
        stubCtx()
      );
    const paths = [
      "/admin-next",
      "/admin-next/reservations",
      "/admin-next%2Freservations",
      "/%61dmin-next",
      "/admin-next%2Freservations%",
      "/admin-next%3Fstore=1",
      "/%61dmin-next%23old",
    ];

    const dbNonProd = createMigratedSqliteD1();
    const dbProd = createMigratedSqliteD1();
    try {
      for (const path of paths) {
        expect((await call(path, baseEnv(dbNonProd))).status).toBe(404);
        expect((await call(path, { ...baseEnv(dbProd), ENVIRONMENT: "production" })).status).toBe(404);
      }
    } finally {
      dbNonProd.sqlite.close();
      dbProd.sqlite.close();
    }
  });
});

const insertSearchableCustomer = (
  db: SqliteD1Database,
  values: {
    id: string;
    displayName: string;
    displayNameKana?: string | null;
    phoneNormalized?: string | null;
    blockStatus?: string;
    updatedAt?: string;
  }
) => {
  db.sqlite
    .prepare(
      `
        INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, block_status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      values.id,
      values.displayName,
      values.displayNameKana ?? null,
      values.phoneNormalized ?? null,
      values.blockStatus ?? "active",
      values.updatedAt ?? "2026-05-12T00:00:00.000Z"
    );
};

describe("admin mutation rate-limit chokepoint (④)", () => {
  // Pre-fill the per-admin admin_mutation bucket to the 300/10min cap so the next
  // state-changing request must be rejected. The key is hashed exactly as
  // enforceRateLimit does (action:adminId).
  const fillAdminMutationBucket = async (db: SqliteD1Database) => {
    const hashedKey = await hashRateLimitKey("admin_mutation", "admin_operations_owner_1");
    const occurredAt = new Date().toISOString();
    const insert = db.sqlite.prepare(
      "INSERT INTO rate_limit_events (id, action, rate_limit_key, occurred_at, metadata_json) VALUES (?, 'admin_mutation', ?, ?, NULL)"
    );
    for (let i = 0; i < 300; i++) {
      insert.run(`rl_seed_${i}`, hashedKey, occurredAt);
    }
  };

  it("429s an owner-only mutation route (authenticateOwnerWithJsonBody path) once the per-admin cap is hit", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      await fillAdminMutationBucket(db);

      // Empty body is fine: the rate-limit fires inside authenticateAdminRoute,
      // BEFORE owner-gate and JSON-body parsing — so a capped admin gets 429,
      // not 400/403. Proves the owner POST path routes through the shared
      // authenticateAdminRoute chokepoint (not just authenticateAdminWithDb).
      const res = await adminRequest(db, access.token, "/api/admin/customers/any_customer/visits", {
        method: "POST",
        body: "{}"
      });
      expect(res.status).toBe(429);
      await expect(res.json()).resolves.toMatchObject({ ok: false, reason: "rate_limited" });
    } finally {
      db.sqlite.close();
    }
  });

  it("429s a sync-conflict mutation route (guardConflictAction path) once the per-admin cap is hit", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      await fillAdminMutationBucket(db);

      // guardConflictAction is a SEPARATE auth primitive (not authenticateAdminRoute);
      // the rate-limit fires before conflictId / idempotency validation, so an empty
      // body still 429s when the bucket is full.
      const res = await adminRequest(db, access.token, "/api/admin/sync/conflicts/any_conflict/approve-cancel", {
        method: "POST",
        body: "{}"
      });
      expect(res.status).toBe(429);
      await expect(res.json()).resolves.toMatchObject({ ok: false, reason: "rate_limited" });
    } finally {
      db.sqlite.close();
    }
  });
});

describe("GET /api/admin/customers (search)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects unauthenticated requests with 403", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      const app = createApp();
      const response = await app.request(
        "/api/admin/customers?q=%E5%B1%B1%E7%94%B0",
        { method: "GET" },
        baseEnv(db)
      );
      expect(response.status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns matching customers with private cache headers for an owner", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertSearchableCustomer(db, {
        id: "cust_api_yamada",
        displayName: "山田 太郎",
        displayNameKana: "ヤマダ タロウ",
        phoneNormalized: "08012345678",
        updatedAt: "2026-05-12T01:00:00.000Z"
      });

      const response = await adminRequest(
        db,
        access.token,
        `/api/admin/customers?q=${encodeURIComponent("山田")}`
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      await expect(response.json()).resolves.toEqual({
        ok: true,
        customers: [
          {
            id: "cust_api_yamada",
            displayName: "山田 太郎",
            displayNameKana: "ヤマダ タロウ",
            phoneNormalized: "08012345678",
            blockStatus: "active",
            memo: null
          }
        ]
      });
    } finally {
      db.sqlite.close();
    }
  });

  it.each([
    `/api/admin/customers?q=${encodeURIComponent("山田")}`,
    `/api/admin/customers/customer-id-xyz`
  ])("forbids staff from %s", async (path) => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "staff");
      const response = await adminRequest(db, access.token, path);
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ ok: false, reason: "forbidden" });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 400 invalid_request for empty queries", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const response = await adminRequest(db, access.token, "/api/admin/customers?q=%20");
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "invalid_request"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 400 invalid_request when q is missing entirely", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const response = await adminRequest(db, access.token, "/api/admin/customers");
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "invalid_request"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("forbids staff from customer detail lookup", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "staff");
      insertSearchableCustomer(db, {
        id: "cust_detail_forbidden_staff",
        displayName: "確認 顧客",
        phoneNormalized: "09012345678"
      });

      const response = await adminRequest(
        db,
        access.token,
        "/api/admin/customers/cust_detail_forbidden_staff"
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "forbidden"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns an empty customers array when no rows match", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const response = await adminRequest(
        db,
        access.token,
        `/api/admin/customers?q=${encodeURIComponent("存在しない人物")}`
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        customers: []
      });
    } finally {
      db.sqlite.close();
    }
  });
});

describe("GET /api/admin/reservations/:id — per-role redaction + staff date scope (P5)", () => {
  const seedNotificationAndCalendar = (db: SqliteD1Database) => {
    db.sqlite
      .prepare(
        `
          INSERT INTO notification_jobs (id, dedupe_key, template_key, recipient_type, recipient_id, reservation_id, status, attempts, last_error, created_at, updated_at)
          VALUES (
            'notif_p5_1',
            'dedupe_notif_p5_1',
            'reservation_confirmed',
            'customer',
            'customer_admin_ops_1',
            'reservation_admin_ops_today_1',
            'failed',
            2,
            'line-422-bad-request',
            '2026-05-09T01:00:00.000Z',
            '2026-05-09T01:00:00.000Z'
          )
        `
      )
      .run();
    db.sqlite
      .prepare(
        `
          INSERT INTO calendar_sync_jobs (id, dedupe_key, owner_type, owner_id, google_action, status, attempts, last_error, created_at, updated_at)
          VALUES (
            'cal_p5_1',
            'dedupe_cal_p5_1',
            'reservation',
            'reservation_admin_ops_today_1',
            'insert',
            'retryable',
            1,
            'google-429-rate',
            '2026-05-09T01:00:00.000Z',
            '2026-05-09T01:00:00.000Z'
          )
        `
      )
      .run();
    db.sqlite
      .prepare(
        `
          INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json, created_at)
          VALUES (
            'audit_p5_1',
            'staff',
            'admin_operations_owner_1',
            'admin_p5_seeded',
            'reservation',
            'reservation_admin_ops_today_1',
            '{"internal":"system_admin_only"}',
            '2026-05-09T02:00:00.000Z'
          )
        `
      )
      .run();
  };

  const insertNonTodayReservation = (db: SqliteD1Database) => {
    db.sqlite
      .prepare(
        `
          INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status, updated_at)
          VALUES ('customer_p5_far', '遠未来', '0750000001', 'phone_hash_p5_far', 'active', '2026-05-09T00:00:00.000Z')
        `
      )
      .run();
    db.sqlite
      .prepare(
        `
          INSERT INTO reservations (
            id, store_id, service_id, customer_id, resource_id, source, status,
            start_at, end_at, duration_minutes, created_by, updated_by, idempotency_key,
            google_sync_state, version, updated_at
          ) VALUES (
            'reservation_p5_far',
            'kyoto',
            'service_kyoto_default_60',
            'customer_p5_far',
            'resource_kyoto_calendar',
            'phone_admin',
            'confirmed',
            '2099-12-31T01:00:00.000Z',
            '2099-12-31T02:00:00.000Z',
            60,
            'admin_operations_owner_1',
            'admin_operations_owner_1',
            'admin_p5_far_fixture',
            'pending',
            1,
            '2026-05-09T00:00:00.000Z'
          )
        `
      )
      .run();
  };

  const FORBIDDEN_NOTIFICATION_KEYS = ["recipientId", "dedupeKey", "lockedUntil", "availableAt"];
  const FORBIDDEN_CALENDAR_KEYS = [
    "dedupeKey",
    "ownerType",
    "ownerId",
    "lockedUntil",
    "availableAt",
    "googleEventId"
  ];
  const AUDIT_ALLOWED_KEYS = new Set([
    "id",
    "actorType",
    "actorId",
    "action",
    "targetType",
    "targetId",
    "createdAt",
    "metadataJson"
  ]);

  it("owner sees populated arrays without lastError or metadataJson string", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      insertTodayReservation(db);
      seedNotificationAndCalendar(db);

      const res = await adminRequest(db, access.token, "/api/admin/reservations/reservation_admin_ops_today_1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: true;
        reservation: {
          phoneNormalized: string | null;
          googleSyncState: string | null;
          googleEventId: string | null;
          audit: Array<Record<string, unknown>>;
          notifications: Array<Record<string, unknown>>;
          calendarSync: Array<Record<string, unknown>>;
        };
      };
      expect(body.ok).toBe(true);
      // Owner sees the raw phone.
      expect(body.reservation.phoneNormalized).toBe("0759999999");
      expect(body.reservation.googleSyncState).toBe("pending");
      expect(body.reservation.audit.length).toBeGreaterThan(0);
      expect(body.reservation.notifications.length).toBeGreaterThan(0);
      expect(body.reservation.calendarSync.length).toBeGreaterThan(0);
      for (const entry of body.reservation.audit) {
        expect(entry.metadataJson).toBeNull();
        for (const key of Object.keys(entry)) {
          expect(AUDIT_ALLOWED_KEYS.has(key)).toBe(true);
        }
      }
      for (const entry of body.reservation.notifications) {
        expect("lastError" in entry).toBe(false);
        for (const forbidden of FORBIDDEN_NOTIFICATION_KEYS) {
          expect(forbidden in entry).toBe(false);
        }
      }
      for (const entry of body.reservation.calendarSync) {
        expect("lastError" in entry).toBe(false);
        for (const forbidden of FORBIDDEN_CALENDAR_KEYS) {
          expect(forbidden in entry).toBe(false);
        }
      }
    } finally {
      db.sqlite.close();
    }
  });

  it("system_admin sees lastError + raw metadataJson on each entry", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "system_admin");
      insertTodayReservation(db);
      seedNotificationAndCalendar(db);

      const res = await adminRequest(db, access.token, "/api/admin/reservations/reservation_admin_ops_today_1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: true;
        reservation: {
          audit: Array<{ metadataJson: string | null }>;
          notifications: Array<{ lastError?: string | null }>;
          calendarSync: Array<{ lastError?: string | null }>;
        };
      };
      expect(body.reservation.audit.some((e) => typeof e.metadataJson === "string")).toBe(true);
      expect(body.reservation.notifications.every((e) => "lastError" in e)).toBe(true);
      expect(body.reservation.calendarSync.every((e) => "lastError" in e)).toBe(true);
      expect(body.reservation.notifications.some((e) => e.lastError === "line-422-bad-request")).toBe(true);
      expect(body.reservation.calendarSync.some((e) => e.lastError === "google-429-rate")).toBe(true);
    } finally {
      db.sqlite.close();
    }
  });

  it("staff sees google fields null and arrays empty for today reservation", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "staff");
      // Link staff to 'kyoto' store via staff_members so the operation's store-scope gate passes
      db.sqlite
        .prepare(
          `INSERT INTO staff_members (id, store_id, display_name, role, active, updated_at)
           VALUES ('staff_member_ops_1', 'kyoto', 'Staff Ops', 'staff', 1, '2026-05-09T00:00:00.000Z')`
        )
        .run();
      db.sqlite
        .prepare(`UPDATE admin_users SET staff_member_id = 'staff_member_ops_1' WHERE id = 'admin_operations_owner_1'`)
        .run();
      insertTodayReservation(db);
      seedNotificationAndCalendar(db);

      const res = await adminRequest(db, access.token, "/api/admin/reservations/reservation_admin_ops_today_1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: true;
        reservation: {
          phoneNormalized: string | null;
          googleSyncState: string | null;
          googleEventId: string | null;
          audit: unknown[];
          notifications: unknown[];
          calendarSync: unknown[];
        };
      };
      // Staff sees only the last-4 masked phone, never the raw number.
      expect(body.reservation.phoneNormalized).toBe("***-****-9999");
      expect(body.reservation.googleSyncState).toBeNull();
      expect(body.reservation.googleEventId).toBeNull();
      expect(body.reservation.audit).toEqual([]);
      expect(body.reservation.notifications).toEqual([]);
      expect(body.reservation.calendarSync).toEqual([]);
    } finally {
      db.sqlite.close();
    }
  });

  it("staff hitting a non-today reservation gets 403 forbidden, body omits reservation", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "staff");
      insertNonTodayReservation(db);
      const res = await adminRequest(db, access.token, "/api/admin/reservations/reservation_p5_far");
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ ok: false, reason: "forbidden" });
    } finally {
      db.sqlite.close();
    }
  });

  it("owner can fetch a non-today reservation", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      insertNonTodayReservation(db);
      const res = await adminRequest(db, access.token, "/api/admin/reservations/reservation_p5_far");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: true; reservation: { id: string } };
      expect(body.reservation.id).toBe("reservation_p5_far");
    } finally {
      db.sqlite.close();
    }
  });

  it("staff fails closed when start_at is unparseable (no fail-open via NaN day key)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "staff");
      db.sqlite
        .prepare(
          `
            INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status, updated_at)
            VALUES ('customer_p5_malformed', '不正データ', '0750000099', 'phone_hash_p5_malformed', 'active', '2026-05-09T00:00:00.000Z')
          `
        )
        .run();
      db.sqlite
        .prepare(
          `
            INSERT INTO reservations (
              id, store_id, service_id, customer_id, resource_id, source, status,
              start_at, end_at, duration_minutes, created_by, updated_by, idempotency_key,
              google_sync_state, version, updated_at
            ) VALUES (
              'reservation_p5_malformed',
              'kyoto',
              'service_kyoto_default_60',
              'customer_p5_malformed',
              'resource_kyoto_calendar',
              'phone_admin',
              'confirmed',
              'malformed-start-AAAAA',
              'malformed-start-ZZZZZ',
              60,
              'admin_operations_owner_1',
              'admin_operations_owner_1',
              'admin_p5_malformed_fixture',
              'pending',
              1,
              '2026-05-09T00:00:00.000Z'
            )
          `
        )
        .run();

      const res = await adminRequest(db, access.token, "/api/admin/reservations/reservation_p5_malformed");
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ ok: false, reason: "forbidden" });
    } finally {
      db.sqlite.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Reservation detail: customerPastNotes (same customer's earlier 施術メモ)
// ---------------------------------------------------------------------------
describe("GET /api/admin/reservations/:id — customerPastNotes", () => {
  // 予約詳細の visits は WHERE reservation_id = ? なので、その予約が完了するまで
  // 施術メモは1件も出ない。施術前に前回のカルテを読む導線がここにしか無いため、
  // 同じ顧客の直近の有効な来店からメモだけを別に引く。
  // visit_source は visited_at の書式から決める。本番では手入力 (manual_import) の
  // visited_at は必ず JST の 'YYYY-MM-DD' 日付キー (書き込み側が regex + round-trip で
  // 検証する)、予約由来 (reservation_completed) は必ず UTC の ISO 文字列 (start_at を
  // そのまま入れるので結果的にそうなる)。ここで常に manual_import にすると、実在しない
  // 組み合わせでクエリを検証することになり、判定を length(visited_at) から visit_source に
  // 変える改修が素通りしてしまう。
  const insertPastVisit = (
    db: SqliteD1Database,
    id: string,
    visitedAt: string,
    notes: string | null,
    opts: { storeId?: string; status?: string; createdAt?: string } = {}
  ) => {
    const source = visitedAt.length === 10 ? "manual_import" : "reservation_completed";
    db.sqlite
      .prepare(
        `INSERT INTO customer_visits (id, customer_id, store_id, visited_at, visit_source, status, recorded_by, treatment_notes, created_at)
         VALUES (?, 'customer_admin_ops_1', ?, ?, ?, ?, 'admin_operations_owner_1', ?, COALESCE(?, CURRENT_TIMESTAMP))`
      )
      .run(id, opts.storeId ?? "kyoto", visitedAt, source, "valid", notes, opts.createdAt ?? null);
    // 無効化は CHECK が void メタデータ3点を要求するので、insert では 'valid' を
    // 入れてから訂正と同じ形で UPDATE する。
    if (opts.status === "voided") {
      db.sqlite
        .prepare(
          `UPDATE customer_visits
           SET status = 'voided', voided_by = 'admin_operations_owner_1',
               voided_at = '2026-05-10T00:00:00.000Z', void_reason = 'reservation_corrected_to_no_show'
           WHERE id = ?`
        )
        .run(id);
    }
  };

  const fetchDetail = async (db: SqliteD1Database, token: string) => {
    const res = await adminRequest(db, token, "/api/admin/reservations/reservation_admin_ops_today_1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      reservation: {
        customerPastNotes: Array<{ visitedAt: string; treatmentNotes: string }>;
        customerPastNotesTruncated: boolean;
      };
    };
    return body.reservation;
  };

  const fetchPastNotes = async (db: SqliteD1Database, token: string) =>
    (await fetchDetail(db, token)).customerPastNotes;

  it("returns the customer's earlier notes newest-first, capped at 3, without this reservation's own visit", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      // insertTodayReservation seeds visit_admin_ops_1 for THIS reservation.
      insertTodayReservation(db);
      // visited_at も予約の開始より前に寄せる。既定の seed は開始1時間後なので、
      // 時刻の条件だけで落ちてしまい `reservation_id <> ?` を消しても気付けない。
      // 本番では restore 系の UPDATE が visited_at を書き換えないまま予約の
      // start_at が動くと、この形の行が実際に現れる。
      db.sqlite
        .prepare(
          `UPDATE customer_visits
           SET treatment_notes = 'この予約の分', visited_at = '2026-05-01T00:00:00.000Z'
           WHERE id = 'visit_admin_ops_1'`
        )
        .run();
      insertPastVisit(db, "visit_past_1", "2026-01-01T00:00:00.000Z", "1回目");
      insertPastVisit(db, "visit_past_2", "2026-02-01T00:00:00.000Z", "2回目");
      insertPastVisit(db, "visit_past_3", "2026-03-01T00:00:00.000Z", "3回目");
      insertPastVisit(db, "visit_past_4", "2026-04-01T00:00:00.000Z", "4回目");

      const notes = await fetchPastNotes(db, access.token);
      expect(notes.map((n) => n.treatmentNotes)).toEqual(["4回目", "3回目", "2回目"]);
      // 自分の予約の来店行は上の visits で出るので、こちらには混ぜない。
      expect(notes.map((n) => n.treatmentNotes)).not.toContain("この予約の分");
      expect(notes[0].visitedAt).toBe("2026-04-01T00:00:00.000Z");
    } finally {
      db.sqlite.close();
    }
  });

  it("orders same-day manual visits deterministically (visited_at is a date key)", async () => {
    // 手動来店の visited_at は 'YYYY-MM-DD' の日付キーなので、同日の行は完全に同値に
    // なる。第2キーが無いと LIMIT 3 で拾う組み合わせが呼び出しごとに変わりうる。
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      insertTodayReservation(db);
      // id は crypto.randomUUID() なので記録順と無関係。ここでは id の降順が記録順の
      // 逆になるように名前を付けてあり、created_at を並び順から外すと期待値が反転する。
      // created_at の書式は CURRENT_TIMESTAMP が書くもの ('YYYY-MM-DD HH:MM:SS') に
      // 揃える。書き込み側は customer_visits.created_at に値を渡す経路が1つも無く、
      // ISO の 'T'/'Z' 付きで入れると本番に存在しない書式で並び順を検証してしまう。
      insertPastVisit(db, "visit_same_day_z", "2026-04-01", "1番目に記録", {
        createdAt: "2026-04-01 01:00:00"
      });
      insertPastVisit(db, "visit_same_day_m", "2026-04-01", "2番目に記録", {
        createdAt: "2026-04-01 02:00:00"
      });
      insertPastVisit(db, "visit_same_day_a", "2026-04-01", "3番目に記録", {
        createdAt: "2026-04-01 03:00:00"
      });
      insertPastVisit(db, "visit_older", "2026-03-01", "古い回");

      const first = await fetchPastNotes(db, access.token);
      const second = await fetchPastNotes(db, access.token);
      expect(first.map((n) => n.treatmentNotes)).toEqual(second.map((n) => n.treatmentNotes));
      // created_at DESC で記録の新しい順。件数上限で「古い回」は落ちる。
      expect(first.map((n) => n.treatmentNotes)).toEqual(["3番目に記録", "2番目に記録", "1番目に記録"]);
    } finally {
      db.sqlite.close();
    }
  });

  it("ranks a same-JST-day mixed pair by the JST-normalized timestamp", async () => {
    // 同じ JST 日に、手入力 (日付キー) と予約由来 (UTC の ISO) が 1 件ずつある形。
    // 素の文字列で並べると '2026-04-02' > '2026-04-01T23:30:00.000Z' なので、JST 08:30 の
    // 回のほうが必ず後ろに回る。第1キーを JST に寄せると ISO 側は '2026-04-02 08:30:00' に
    // なり、時刻を持たない日付キー ('2026-04-02') より後ろ = DESC で先頭に来る。
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      insertTodayReservation(db);
      // id の降順は manual が先。正規化を外すと日付キー側が勝つので、id では救えない。
      insertPastVisit(db, "visit_mixed_manual", "2026-04-02", "手入力 (先に記録)", {
        createdAt: "2026-04-02 01:00:00"
      });
      insertPastVisit(db, "visit_mixed_iso", "2026-04-01T23:30:00.000Z", "JST 08:30 の回 (後に記録)", {
        createdAt: "2026-04-02 02:00:00"
      });

      const notes = await fetchPastNotes(db, access.token);
      expect(notes.map((n) => n.treatmentNotes)).toEqual(["JST 08:30 の回 (後に記録)", "手入力 (先に記録)"]);
    } finally {
      db.sqlite.close();
    }
  });

  it("keeps the visit order of two same-JST-day reservation visits (not the order they were completed)", async () => {
    // 予約由来どうしが同じ JST 日に 2 件ある形。第1キーを日に丸めると両者が同値になり、
    // 来店順ではなく完了処理をした順 (created_at) で並ぶ。完了処理はまとめて後日行われる
    // ことがある (src/admin/reservations.ts のコメント参照) ので、それは来店順ではない。
    // 3 件で打ち切る画面なので、この取り違えは「新しいほうが落ちて古いほうが最新として出る」
    // という形で利用者に届く。
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      insertTodayReservation(db);
      // id の降順は AM が先。丸めを戻すと AM が勝つので、id では救えない。
      insertPastVisit(db, "visit_iso_z_am", "2026-04-01T01:00:00.000Z", "JST 10:00 の回", {
        createdAt: "2026-04-01 02:00:00"
      });
      insertPastVisit(db, "visit_iso_a_pm", "2026-04-01T06:00:00.000Z", "JST 15:00 の回", {
        createdAt: "2026-04-01 01:00:00"
      });

      const notes = await fetchPastNotes(db, access.token);
      expect(notes.map((n) => n.treatmentNotes)).toEqual(["JST 15:00 の回", "JST 10:00 の回"]);
    } finally {
      db.sqlite.close();
    }
  });

  it("flags truncation only when a 4th earlier note exists", async () => {
    // 「これより前のぶんは…」の案内は件数では決められない。ちょうど3件しかない顧客と
    // 打ち切られた顧客がどちらも 3 件で返るため、4件目の有無を worker 側が判定して返す。
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      insertTodayReservation(db);
      insertPastVisit(db, "visit_cap_1", "2026-01-01T00:00:00.000Z", "1回目");
      insertPastVisit(db, "visit_cap_2", "2026-02-01T00:00:00.000Z", "2回目");
      insertPastVisit(db, "visit_cap_3", "2026-03-01T00:00:00.000Z", "3回目");

      const exactlyThree = await fetchDetail(db, access.token);
      expect(exactlyThree.customerPastNotes).toHaveLength(3);
      expect(exactlyThree.customerPastNotesTruncated).toBe(false);

      insertPastVisit(db, "visit_cap_4", "2026-04-01T00:00:00.000Z", "4回目");
      const truncated = await fetchDetail(db, access.token);
      expect(truncated.customerPastNotesTruncated).toBe(true);
      // 判定に使う4件目は応答に載せない。
      expect(truncated.customerPastNotes.map((n) => n.treatmentNotes)).toEqual(["4回目", "3回目", "2回目"]);
    } finally {
      db.sqlite.close();
    }
  });

  it("skips visits whose notes are only whitespace or newlines", async () => {
    // SQLite の 1 引数 trim() は半角スペースしか落とさない。紙カルテ取り込みのような
    // 過去データで改行や全角スペースだけのメモが来ても、日付だけの空ブロックを出さない。
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      insertTodayReservation(db);
      insertPastVisit(db, "visit_newlines", "2026-04-01T00:00:00.000Z", "\n\n");
      insertPastVisit(db, "visit_tabs", "2026-03-01T00:00:00.000Z", "\t");
      // 全角スペースだけの行。日本語の手入力データで一番出やすい形なので、
      // trim の文字集合から U+3000 が落ちたらここで気付ける。
      insertPastVisit(db, "visit_ideographic_space", "2026-03-15T00:00:00.000Z", "\u3000\u3000");
      insertPastVisit(db, "visit_real", "2026-02-01T00:00:00.000Z", "本物のメモ");

      const notes = await fetchPastNotes(db, access.token);
      expect(notes.map((n) => n.treatmentNotes)).toEqual(["本物のメモ"]);
    } finally {
      db.sqlite.close();
    }
  });

  it("skips voided visits and visits with no notes", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      insertTodayReservation(db);
      insertPastVisit(db, "visit_no_notes", "2026-04-01T00:00:00.000Z", null);
      insertPastVisit(db, "visit_blank_notes", "2026-03-01T00:00:00.000Z", "   ");
      // 訂正で無効化された来店のメモは「無かったこと」なので出さない (specs/005)。
      insertPastVisit(db, "visit_voided", "2026-02-01T00:00:00.000Z", "取り消した回", { status: "voided" });
      insertPastVisit(db, "visit_kept", "2026-01-01T00:00:00.000Z", "生きている回");

      const notes = await fetchPastNotes(db, access.token);
      expect(notes.map((n) => n.treatmentNotes)).toEqual(["生きている回"]);
    } finally {
      db.sqlite.close();
    }
  });

  it("excludes notes recorded after the reservation being viewed", async () => {
    // 「過去の」施術メモと名乗る以上、終了済みの予約を開いたときに、その後に記録された
    // カルテが並んではいけない。
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      insertTodayReservation(db);
      insertPastVisit(db, "visit_before", "2026-01-01T00:00:00.000Z", "予約より前");
      insertPastVisit(db, "visit_after", "2099-01-01T00:00:00.000Z", "予約より後");

      const notes = await fetchPastNotes(db, access.token);
      expect(notes.map((n) => n.treatmentNotes)).toEqual(["予約より前"]);
    } finally {
      db.sqlite.close();
    }
  });

  it("keeps a same-JST-day manual note when the reservation starts before 09:00 JST", async () => {
    // 手動来店の visited_at は JST の日付キー、予約の start_at は UTC の ISO。素の文字列
    // 比較だと JST 09:00 より前に始まる回だけ start_at の UTC 日付が前日になり、同じ JST 日に
    // 手入力したメモが落ちて、同じデータでも開始時刻で結果が変わる。ここで JST 08:00 の
    // 回を固定しておくと、正規化を外した瞬間にこのテストが落ちる。
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      insertTodayReservation(db);

      const jstToday = todayJstSlot().startAt.slice(0, 10);
      const jstEightAm = new Date(`${jstToday}T00:00:00.000Z`).getTime() - 60 * 60 * 1000;
      db.sqlite
        .prepare(`UPDATE reservations SET start_at = ? WHERE id = 'reservation_admin_ops_today_1'`)
        .run(new Date(jstEightAm).toISOString());

      insertPastVisit(db, "visit_same_jst_day", jstToday, "同じ JST 日の手入力");
      const jstTomorrow = new Date(`${jstToday}T00:00:00.000Z`);
      jstTomorrow.setUTCDate(jstTomorrow.getUTCDate() + 1);
      insertPastVisit(db, "visit_next_jst_day", jstTomorrow.toISOString().slice(0, 10), "翌 JST 日の手入力");

      const notes = await fetchPastNotes(db, access.token);
      expect(notes.map((n) => n.treatmentNotes)).toEqual(["同じ JST 日の手入力"]);
    } finally {
      db.sqlite.close();
    }
  });

  it("owner sees notes from every store (staff-only store filter)", async () => {
    // authz マトリクスに「staff は自店舗ぶんだけ」と書いた裏返し。store 条件を
    // 無条件にする「単純化」を入れると owner から他店舗のカルテが消えるので、
    // その形をここで固定する。
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      insertTodayReservation(db);
      insertPastVisit(db, "visit_own_store", "2026-04-01T00:00:00.000Z", "自店舗の回");
      insertPastVisit(db, "visit_other_store", "2026-05-01T00:00:00.000Z", "他店舗の回", { storeId: "osaka" });

      const notes = await fetchPastNotes(db, access.token);
      expect(notes.map((n) => n.treatmentNotes)).toEqual(["他店舗の回", "自店舗の回"]);
    } finally {
      db.sqlite.close();
    }
  });

  it("staff only sees notes recorded at their own store", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertTodayReservation(db);
      insertPastVisit(db, "visit_own_store", "2026-04-01T00:00:00.000Z", "自店舗の回");
      insertPastVisit(db, "visit_other_store", "2026-05-01T00:00:00.000Z", "他店舗の回", { storeId: "osaka" });

      const staff: AdminUser = {
        id: "admin_kyoto_staff",
        email: "staff-kyoto@example.com",
        role: "staff",
        staff_member_id: "staff_kyoto",
        store_id: "kyoto"
      };
      const result = await getAdminReservationDetail({
        db: db as unknown as D1Database,
        reservationId: "reservation_admin_ops_today_1",
        admin: staff
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reservation.customerPastNotes.map((n) => n.treatmentNotes)).toEqual(["自店舗の回"]);
    } finally {
      db.sqlite.close();
    }
  });

  // owner 以上には全店舗ぶんが並ぶ。どこで受けた施術かが分からないと、別店舗の内容を
  // 自店舗の履歴として読んでしまう (issue #649)。画面はこの店舗 ID を予約の店舗と
  // 比べてバッジを出すので、名前だけでなく ID も返す必要がある。
  it("returns the store of each past note so the owner can tell them apart", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertTodayReservation(db);
      insertPastVisit(db, "visit_own_store", "2026-04-01T00:00:00.000Z", "自店舗の回");
      insertPastVisit(db, "visit_other_store", "2026-05-01T00:00:00.000Z", "他店舗の回", { storeId: "osaka" });

      const result = await getAdminReservationDetail({
        db: db as unknown as D1Database,
        reservationId: "reservation_admin_ops_today_1",
        admin: {
          id: "admin_operations_owner_1",
          email: "owner@example.com",
          role: "owner",
          staff_member_id: null,
          store_id: null
        }
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(
        result.reservation.customerPastNotes.map((n) => ({
          treatmentNotes: n.treatmentNotes,
          storeId: n.storeId,
          storeName: n.storeName
        }))
      ).toEqual([
        { treatmentNotes: "他店舗の回", storeId: "osaka", storeName: "ExampleStore B" },
        { treatmentNotes: "自店舗の回", storeId: "kyoto", storeName: "ExampleStore A" }
      ]);
    } finally {
      db.sqlite.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Reservation detail: customerMemo / customerAllergyNotes (detail-only PII)
// ---------------------------------------------------------------------------
describe("GET /api/admin/reservations/:id — customerMemo / customerAllergyNotes", () => {
  const MEMO_TEXT = "アレルギー: ラテックス。メモは詳細のみ。";
  const ALLERGY_TEXT = "リドカイン禁忌";

  const seedCustomerNotes = (db: SqliteD1Database, memo: string | null, allergy: string | null) => {
    insertTodayReservation(db);
    db.sqlite
      .prepare(`UPDATE customers SET memo = ?, allergy_notes = ? WHERE id = 'customer_admin_ops_1'`)
      .run(memo, allergy);
  };

  it("returns customerMemo and customerAllergyNotes when set", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      seedCustomerNotes(db, MEMO_TEXT, ALLERGY_TEXT);

      const res = await adminRequest(db, access.token, "/api/admin/reservations/reservation_admin_ops_today_1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: true;
        reservation: {
          customerMemo: string | null;
          customerAllergyNotes: string | null;
        };
      };
      expect(body.reservation.customerMemo).toBe(MEMO_TEXT);
      expect(body.reservation.customerAllergyNotes).toBe(ALLERGY_TEXT);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns null for empty-string and missing notes", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      // Empty string must normalize to null (contract: 空文字 → null).
      seedCustomerNotes(db, "", "");

      const res = await adminRequest(db, access.token, "/api/admin/reservations/reservation_admin_ops_today_1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: true;
        reservation: {
          customerMemo: string | null;
          customerAllergyNotes: string | null;
        };
      };
      expect(body.reservation.customerMemo).toBeNull();
      expect(body.reservation.customerAllergyNotes).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it("returns null when memo / allergy_notes columns are NULL", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      seedCustomerNotes(db, null, null);

      const res = await adminRequest(db, access.token, "/api/admin/reservations/reservation_admin_ops_today_1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: true;
        reservation: {
          customerMemo: string | null;
          customerAllergyNotes: string | null;
        };
      };
      expect(body.reservation.customerMemo).toBeNull();
      expect(body.reservation.customerAllergyNotes).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it("out-of-scope staff is rejected BEFORE the customer-notes PII query runs (operation-level)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCustomerNotes(db, MEMO_TEXT, ALLERGY_TEXT);
      const otherStoreStaff: AdminUser = {
        id: "admin_other_store_staff",
        email: "staff-other@example.com",
        role: "staff",
        staff_member_id: "staff_other_store",
        store_id: "osaka"
      };

      const prepareSpy = vi.spyOn(db, "prepare");

      // Staff with no store binding: rejected before ANY query runs.
      const unboundResult = await getAdminReservationDetail({
        db: db as unknown as D1Database,
        reservationId: "reservation_admin_ops_today_1",
        admin: { ...otherStoreStaff, store_id: null }
      });
      expect(unboundResult).toEqual({ ok: false, reason: "forbidden" });
      expect(prepareSpy).not.toHaveBeenCalled();

      // Other-store staff: only the store_id-only probe runs. reservationSelect
      // itself joins customer name / kana / raw phone, so the probe must be the
      // single query — the route's 403 must not be the only gate, because by then
      // the PII would already have left D1.
      const result = await getAdminReservationDetail({
        db: db as unknown as D1Database,
        reservationId: "reservation_admin_ops_today_1",
        admin: otherStoreStaff
      });
      expect(result).toEqual({ ok: false, reason: "forbidden" });
      const sqls = prepareSpy.mock.calls.map(([sql]) => String(sql));
      expect(sqls).toHaveLength(1);
      expect(sqls[0]).toContain("SELECT store_id FROM reservations");
      for (const piiFragment of ["display_name", "phone_normalized", "allergy_notes", "customer_visits", "memo"]) {
        expect(sqls[0], `probe query must not touch ${piiFragment}`).not.toContain(piiFragment);
      }
    } finally {
      db.sqlite.close();
    }
  });

  it("does NOT include memo / allergy_notes on list, search, CSV, or customer history", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      seedCustomerNotes(db, MEMO_TEXT, ALLERGY_TEXT);

      // Daily list
      const listRes = await adminRequest(db, access.token, "/api/admin/reservations?range=today");
      expect(listRes.status).toBe(200);
      const listBody = await listRes.json();
      const listJson = JSON.stringify(listBody);
      expect(listJson).not.toContain("customerMemo");
      expect(listJson).not.toContain("customerPastNotes");
      expect(listJson).not.toContain("customerAllergyNotes");
      expect(listJson).not.toContain("allergy_notes");
      expect(listJson).not.toContain(MEMO_TEXT);
      expect(listJson).not.toContain(ALLERGY_TEXT);

      // Period search / CSV: window must stay within PERIOD_MAX_DAYS (92).
      // Bracket "today" (JST) so the fixture reservation is included.
      const jstToday = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(new Date()); // YYYY-MM-DD
      const periodQs = `from=${jstToday}&to=${jstToday}`;

      // Period search (JSON)
      const searchRes = await adminRequest(
        db,
        access.token,
        `/api/admin/reservations/search?${periodQs}`
      );
      expect(searchRes.status).toBe(200);
      const searchJson = JSON.stringify(await searchRes.json());
      expect(searchJson).not.toContain("customerMemo");
      expect(searchJson).not.toContain("customerPastNotes");
      expect(searchJson).not.toContain("customerAllergyNotes");
      expect(searchJson).not.toContain(MEMO_TEXT);
      expect(searchJson).not.toContain(ALLERGY_TEXT);

      // CSV export
      const csvRes = await adminRequest(
        db,
        access.token,
        `/api/admin/reservations/export.csv?${periodQs}`
      );
      expect(csvRes.status).toBe(200);
      const csvText = await csvRes.text();
      expect(csvText).not.toContain("customerMemo");
      expect(csvText).not.toContain("customerPastNotes");
      expect(csvText).not.toContain("allergy");
      expect(csvText).not.toContain(MEMO_TEXT);
      expect(csvText).not.toContain(ALLERGY_TEXT);

      // Customer detail history embeds reservation list items — also no memo fields
      // on those nested reservation rows (customer-level memo is separate: .memo).
      const customerRes = await adminRequest(db, access.token, "/api/admin/customers/customer_admin_ops_1");
      expect(customerRes.status).toBe(200);
      const customerBody = (await customerRes.json()) as {
        ok: true;
        customer: {
          memo: string | null;
          allergyNotes: string | null;
          reservations: Array<Record<string, unknown>>;
        };
      };
      // Customer karte itself DOES expose memo (different endpoint contract).
      expect(customerBody.customer.memo).toBe(MEMO_TEXT);
      expect(customerBody.customer.allergyNotes).toBe(ALLERGY_TEXT);
      for (const reservation of customerBody.customer.reservations) {
        expect("customerMemo" in reservation).toBe(false);
        expect("customerAllergyNotes" in reservation).toBe(false);
        expect("customerPastNotes" in reservation).toBe(false);
        expect("memo" in reservation).toBe(false);
        expect("allergyNotes" in reservation).toBe(false);
      }
    } finally {
      db.sqlite.close();
    }
  });

  it("staff of another store gets 403 on reservation detail (operation-level store gate)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "staff");
      // Staff bound to osaka — reservation is kyoto.
      db.sqlite
        .prepare(
          `INSERT INTO staff_members (id, store_id, display_name, role, active, updated_at)
           VALUES ('staff_member_ops_osaka', 'osaka', 'Staff Osaka', 'staff', 1, '2026-05-09T00:00:00.000Z')`
        )
        .run();
      db.sqlite
        .prepare(
          `UPDATE admin_users SET staff_member_id = 'staff_member_ops_osaka' WHERE id = 'admin_operations_owner_1'`
        )
        .run();
      seedCustomerNotes(db, MEMO_TEXT, ALLERGY_TEXT);

      const res = await adminRequest(
        db,
        access.token,
        "/api/admin/reservations/reservation_admin_ops_today_1"
      );
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ ok: false, reason: "forbidden" });
    } finally {
      db.sqlite.close();
    }
  });
});

// 来店履歴 1 ページの件数はサーバーと管理画面の 2 箇所にある。ずれると「さらに読み込む」が
// 出ないか、出たまま空を引き続ける。どちらも黙って壊れるので、値の一致を固定する
// (顧客タブゲートの MAX_ATTEMPTS と同じ形)。
describe("来店履歴のページサイズ", () => {
  it("サーバーと管理画面で同じ件数を持つ", () => {
    const readConstant = (path: string) => {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      const match = /CUSTOMER_VISITS_PAGE_SIZE = (\d+);/.exec(source);
      expect(match).not.toBeNull();
      return Number(match?.[1]);
    };

    expect(readConstant("../admin-app/src/components/customers/customer-detail-panel.tsx")).toBe(
      readConstant("../src/admin/operations.ts")
    );
  });
});
