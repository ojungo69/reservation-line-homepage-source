import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { createAccessJwksFetchMock, createAccessJwtFixture as createSignedAccessJwtFixture, insertAdminUser as insertAdminUserHelper, type AdminRole } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-settings-services-aud";
const ADMIN_EMAIL = "owner@example.com";
const ADMIN_ACCESS_SUBJECT = "access-subject-admin-settings-services";
const ACCESS_KEY_ID = "admin-settings-services-key-1";


const createAccessJwtFixture = () =>
  createSignedAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: ACCESS_KEY_ID,
    claims: { email: ADMIN_EMAIL, sub: ADMIN_ACCESS_SUBJECT }
  });

const createFetchMock = (jwk: ReturnType<typeof createAccessJwtFixture>["jwk"]) =>
  createAccessJwksFetchMock(TEAM_DOMAIN, jwk);

const insertAdminUser = (db: SqliteD1Database, role: AdminRole = "owner") =>
  insertAdminUserHelper(db, {
    id: "admin_settings_services_1",
    email: ADMIN_EMAIL,
    accessSubject: ADMIN_ACCESS_SUBJECT,
    role,
    updatedAt: "2026-05-19T00:00:00.000Z",
  });

const seedStore = (db: SqliteD1Database, id = "store_test") => {
  db.sqlite
    .prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, 'Asia/Tokyo')`)
    .run(id, `Store ${id}`);
};

const seedService = (
  db: SqliteD1Database,
  input: { id: string; storeId: string; name?: string; active?: 0 | 1 }
) => {
  db.sqlite
    .prepare(
      `
        INSERT INTO services (
          id, store_id, name, duration_minutes, buffer_before_minutes,
          buffer_after_minutes, active, created_at, updated_at
        ) VALUES (?, ?, ?, 60, 0, 0, ?, '2026-05-19T00:00:00.000Z', '2026-05-19T00:00:00.000Z')
      `
    )
    .run(input.id, input.storeId, input.name ?? "既存サービス", input.active ?? 1);
};

const seedReservationServiceJunction = (
  db: SqliteD1Database,
  input: { reservationId: string; serviceId: string; displayOrder?: number; durationMinutes?: number }
) => {
  db.sqlite
    .prepare(
      `
        INSERT INTO reservation_services (
          reservation_id, service_id, display_order, name_snapshot, duration_minutes
        ) VALUES (?, ?, ?, 'junction snapshot', ?)
      `
    )
    .run(
      input.reservationId,
      input.serviceId,
      input.displayOrder ?? 1,
      input.durationMinutes ?? 30
    );
};

const seedFutureReservation = (
  db: SqliteD1Database,
  input: { id: string; storeId: string; serviceId: string; startAt: string; status?: "confirmed" | "pending_approval" }
) => {
  db.sqlite
    .prepare(
      `
        INSERT INTO customers (id, display_name, phone_normalized, phone_hash, updated_at)
        VALUES (?, '予約顧客', '09012345678', 'hash', '2026-05-19T00:00:00.000Z')
      `
    )
    .run(`customer_${input.id}`);
  db.sqlite
    .prepare(
      `
        INSERT INTO store_resources (id, store_id, name)
        VALUES (?, ?, 'Calendar')
        ON CONFLICT (id) DO NOTHING
      `
    )
    .run(`resource_${input.storeId}`, input.storeId);
  db.sqlite
    .prepare(
      `
        INSERT INTO reservations (
          id, store_id, service_id, customer_id, resource_id, source,
          status, start_at, end_at, duration_minutes, idempotency_key,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'admin', ?, ?, ?, 60, ?, '2026-05-19T00:00:00.000Z', '2026-05-19T00:00:00.000Z')
      `
    )
    .run(
      input.id,
      input.storeId,
      input.serviceId,
      `customer_${input.id}`,
      `resource_${input.storeId}`,
      input.status ?? "confirmed",
      input.startAt,
      input.startAt.replace("T01", "T02"),
      `key_${input.id}`
    );
};

const baseEnv = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db
});

const adminRequest = (
  db: SqliteD1Database,
  token: string | null,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: Record<string, unknown>
) => {
  const app = createApp();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Cf-Access-Jwt-Assertion"] = token;
  return app.request(
    path,
    {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    },
    baseEnv(db)
  );
};

const readJson = async (response: Response) => response.json() as Promise<Record<string, unknown>>;

const seedHistoricalServiceCreateIdempotency = (
  db: SqliteD1Database,
  input: {
    serviceId: string;
    idempotencyKey: string;
    storeId: string;
    name: string;
    durationMinutes: number;
    bufferBeforeMinutes: number;
    bufferAfterMinutes: number;
    active: boolean;
    priceLabel?: string | null;
  }
) => {
  const payload: Record<string, unknown> = {
    storeId: input.storeId,
    name: input.name,
    durationMinutes: input.durationMinutes,
    bufferBeforeMinutes: input.bufferBeforeMinutes,
    bufferAfterMinutes: input.bufferAfterMinutes,
    active: input.active
  };
  if (input.priceLabel != null) payload.priceLabel = input.priceLabel;
  const requestHash = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
  db.sqlite
    .prepare(
      `INSERT INTO idempotency_keys (
         id, scope, idempotency_key, status, target_type, target_id, request_hash, expires_at
       ) VALUES (?, 'admin_action', ?, 'succeeded', 'service', ?, ?, '2099-12-31T00:00:00.000Z')`
    )
    .run(`legacy_${input.idempotencyKey}`, input.idempotencyKey, input.serviceId, requestHash);
};

const futureSlot = "2026-12-01T01:00:00.000Z";

describe("admin settings services endpoints", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("POST /api/admin/settings/services", () => {
    it("creates a service, writes audit_logs + idempotency rows, and returns 201 for owner", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", {
          storeId: "store_test",
          name: "新メニュー",
          priceLabel: "  10,000円（税込）  ",
          priceAmount: 10_000,
          comboPriceAmount: 8_000,
          comboWithPrefix: "脱毛",
          durationMinutes: 45,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true,
          mensMenu: true,
          idempotencyKey: "create-owner-1"
        });

        expect(response.status).toBe(201);
        const body = await readJson(response);
        expect(body).toMatchObject({ ok: true, replayed: false });
        const serviceId = body.serviceId as string;
        expect(serviceId).toBeTruthy();

        const row = db.sqlite
          .prepare("SELECT name, price_label, price_amount, combo_price_amount, combo_with_prefix, duration_minutes, buffer_before_minutes, buffer_after_minutes, active, mens_menu FROM services WHERE id = ?")
          .get(serviceId) as { name: string; price_label: string | null; price_amount: number | null; combo_price_amount: number | null; combo_with_prefix: string | null; duration_minutes: number; buffer_before_minutes: number; buffer_after_minutes: number; active: number; mens_menu: number };
        expect(row).toMatchObject({
          name: "新メニュー",
          price_label: "10,000円（税込）",
          price_amount: 10_000,
          combo_price_amount: 8_000,
          combo_with_prefix: "脱毛",
          duration_minutes: 45,
          buffer_before_minutes: 0,
          buffer_after_minutes: 0,
          active: 1,
          mens_menu: 1
        });

        const audit = db.sqlite
          .prepare("SELECT action, target_type, target_id, metadata_json FROM audit_logs WHERE action = 'settings.services.create'")
          .get() as { action: string; target_type: string; target_id: string; metadata_json: string };
        expect(audit).toMatchObject({
          action: "settings.services.create",
          target_type: "service",
          target_id: serviceId
        });
        const meta = JSON.parse(audit.metadata_json);
        expect(meta).toMatchObject({
          serviceId,
          storeId: "store_test",
          name: "新メニュー",
          priceLabel: "10,000円（税込）",
          priceAmount: 10_000,
          comboPriceAmount: 8_000,
          comboWithPrefix: "脱毛",
          mensMenu: true,
          adminRole: "owner"
        });

        const idem = db.sqlite
          .prepare("SELECT status, target_id, target_type FROM idempotency_keys WHERE scope = 'admin_action' AND idempotency_key = ?")
          .get("create-owner-1") as { status: string; target_id: string; target_type: string };
        expect(idem).toMatchObject({ status: "succeeded", target_id: serviceId, target_type: "service" });
      } finally {
        db.sqlite.close();
      }
    });

    it("replays the same idempotencyKey + same payload as 200 replayed:true (no duplicate row)", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const payload = {
          storeId: "store_test",
          name: "リプレイ確認",
          durationMinutes: 30,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true,
          idempotencyKey: "create-replay-1"
        };
        const first = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", payload);
        expect(first.status).toBe(201);
        const firstBody = await readJson(first);
        const firstId = firstBody.serviceId as string;

        const second = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", payload);
        expect(second.status).toBe(200);
        await expect(readJson(second)).resolves.toMatchObject({ ok: true, replayed: true, serviceId: firstId });
        expect(db.sqlite.prepare("SELECT price_amount, combo_price_amount, combo_with_prefix FROM services WHERE id = ?").get(firstId)).toEqual({
          price_amount: null,
          combo_price_amount: null,
          combo_with_prefix: null
        });

        const count = (
          db.sqlite.prepare("SELECT COUNT(*) AS count FROM services WHERE name = 'リプレイ確認'").get() as { count: number }
        ).count;
        expect(count).toBe(1);
      } finally {
        db.sqlite.close();
      }
    });

    it("replays a pre-deploy create hash when priceLabel is omitted or null", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const serviceId = "svc_legacy_price_null";
        seedService(db, { id: serviceId, storeId: "store_test", name: "旧形式リプレイ" });
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const payload = {
          storeId: "store_test",
          name: "旧形式リプレイ",
          durationMinutes: 60,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true,
          idempotencyKey: "create-legacy-price-null-replay-1"
        };
        seedHistoricalServiceCreateIdempotency(db, { serviceId, ...payload });

        const omitted = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", payload);
        expect(omitted.status).toBe(200);
        await expect(readJson(omitted)).resolves.toMatchObject({ ok: true, replayed: true, serviceId });

        const explicitNull = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", {
          ...payload,
          priceLabel: null
        });
        expect(explicitNull.status).toBe(200);
        await expect(readJson(explicitNull)).resolves.toMatchObject({ ok: true, replayed: true, serviceId });
      } finally {
        db.sqlite.close();
      }
    });

    it("replays the current priceLabel hash when numeric price fields are omitted", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const serviceId = "svc_price_label_hash_replay";
        seedService(db, { id: serviceId, storeId: "store_test", name: "現行形式リプレイ" });
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const payload = {
          storeId: "store_test",
          name: "現行形式リプレイ",
          priceLabel: "10,000円",
          durationMinutes: 60,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true,
          idempotencyKey: "create-price-label-hash-replay-1"
        };
        seedHistoricalServiceCreateIdempotency(db, { serviceId, ...payload });

        const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", payload);
        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toMatchObject({ ok: true, replayed: true, serviceId });
      } finally {
        db.sqlite.close();
      }
    });

    it("conflicts with a pre-deploy create hash when priceLabel is non-null", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const serviceId = "svc_legacy_price_conflict";
        seedService(db, { id: serviceId, storeId: "store_test", name: "旧形式料金競合" });
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const payload = {
          storeId: "store_test",
          name: "旧形式料金競合",
          durationMinutes: 60,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true,
          idempotencyKey: "create-legacy-price-conflict-1"
        };
        seedHistoricalServiceCreateIdempotency(db, { serviceId, ...payload });

        const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", {
          ...payload,
          priceLabel: "10,000円"
        });
        expect(response.status).toBe(409);
        await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "idempotency_conflict" });
      } finally {
        db.sqlite.close();
      }
    });

    it("treats omitted and explicit-null priceLabel as the same idempotent create payload", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const payload = {
          storeId: "store_test",
          name: "料金未設定リプレイ",
          durationMinutes: 30,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true,
          idempotencyKey: "create-price-null-replay-1"
        };
        const first = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", payload);
        expect(first.status).toBe(201);
        const firstBody = await readJson(first);
        const serviceId = firstBody.serviceId as string;

        const second = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", {
          ...payload,
          priceLabel: null
        });
        expect(second.status).toBe(200);
        await expect(readJson(second)).resolves.toMatchObject({ ok: true, replayed: true, serviceId });
        const row = db.sqlite
          .prepare("SELECT price_label FROM services WHERE id = ?")
          .get(serviceId) as { price_label: string | null };
        expect(row.price_label).toBeNull();
      } finally {
        db.sqlite.close();
      }
    });

    it("normalizes an empty priceLabel to null", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", {
          storeId: "store_test",
          name: "空料金",
          priceLabel: "   ",
          durationMinutes: 30,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true,
          idempotencyKey: "create-empty-price-1"
        });
        expect(response.status).toBe(201);
        const serviceId = (await readJson(response)).serviceId as string;
        const row = db.sqlite
          .prepare("SELECT price_label FROM services WHERE id = ?")
          .get(serviceId) as { price_label: string | null };
        expect(row.price_label).toBeNull();
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 409 idempotency_conflict when the same key is reused with a different payload", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const base = {
          storeId: "store_test",
          name: "オリジナル",
          durationMinutes: 60,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true,
          idempotencyKey: "create-conflict-1"
        };
        const first = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", base);
        expect(first.status).toBe(201);

        const second = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", {
          ...base,
          name: "別の名前"
        });
        expect(second.status).toBe(409);
        await expect(readJson(second)).resolves.toMatchObject({ ok: false, error: "idempotency_conflict" });
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 409 idempotency_conflict when only priceLabel changes for the same key", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const payload = {
          storeId: "store_test",
          name: "料金差分競合",
          priceLabel: "10,000円",
          durationMinutes: 60,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true,
          idempotencyKey: "create-price-conflict-1"
        };
        const first = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", payload);
        expect(first.status).toBe(201);

        const second = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", {
          ...payload,
          priceLabel: "12,000円"
        });
        expect(second.status).toBe(409);
        await expect(readJson(second)).resolves.toMatchObject({ ok: false, error: "idempotency_conflict" });
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 409 idempotency_conflict when only priceAmount changes for the same key", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));
        const payload = {
          storeId: "store_test",
          name: "数値料金差分競合",
          priceAmount: 10_000,
          durationMinutes: 60,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true,
          idempotencyKey: "create-price-amount-conflict-1"
        };

        expect((await adminRequest(db, access.token, "POST", "/api/admin/settings/services", payload)).status).toBe(201);
        const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", {
          ...payload,
          priceAmount: 12_000
        });
        expect(response.status).toBe(409);
        await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "idempotency_conflict" });
      } finally {
        db.sqlite.close();
      }
    });

    it.each([
      ["combo price without prefix", { priceAmount: 10_000, comboPriceAmount: 8_000 }],
      ["combo prefix without combo price", { priceAmount: 10_000, comboWithPrefix: "脱毛" }],
      ["combo tuple without base price", { comboPriceAmount: 8_000, comboWithPrefix: "脱毛" }]
    ])("returns 400 invalid_request for %s", async (_case, prices) => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));
        const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", {
          storeId: "store_test",
          name: "不正組み合わせ",
          ...prices,
          durationMinutes: 30,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true,
          idempotencyKey: `create-invalid-combo-${_case}`
        });
        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "invalid_request" });
      } finally {
        db.sqlite.close();
      }
    });

    it.each([
      ["string priceAmount", { priceAmount: "1000" }],
      ["fractional priceAmount", { priceAmount: 1_500.5 }],
      ["negative priceAmount", { priceAmount: -1 }],
      ["priceAmount above limit", { priceAmount: 1_000_001 }],
      ["string comboPriceAmount", { priceAmount: 10_000, comboPriceAmount: "8000", comboWithPrefix: "脱毛" }],
      ["fractional comboPriceAmount", { priceAmount: 10_000, comboPriceAmount: 8_000.5, comboWithPrefix: "脱毛" }],
      ["negative comboPriceAmount", { priceAmount: 10_000, comboPriceAmount: -1, comboWithPrefix: "脱毛" }],
      ["comboPriceAmount above limit", { priceAmount: 10_000, comboPriceAmount: 1_000_001, comboWithPrefix: "脱毛" }],
      ["prefix containing separator", { priceAmount: 10_000, comboPriceAmount: 8_000, comboWithPrefix: "脱毛｜ヒゲ" }],
      ["41-character prefix", { priceAmount: 10_000, comboPriceAmount: 8_000, comboWithPrefix: "脱".repeat(41) }],
      ["empty prefix", { priceAmount: 10_000, comboPriceAmount: 8_000, comboWithPrefix: "   " }]
    ])("returns 400 invalid_request for %s", async (_case, prices) => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));
        const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", {
          storeId: "store_test",
          name: "不正数値料金",
          ...prices,
          durationMinutes: 30,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true,
          idempotencyKey: `create-invalid-price-fields-${_case}`
        });
        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "invalid_request" });
      } finally {
        db.sqlite.close();
      }
    });

    it.each([
      ["longer than 80 characters", "料".repeat(81)],
      ["not a string or null", 123]
    ])("returns 400 invalid_request when priceLabel is %s", async (_case, priceLabel) => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", {
          storeId: "store_test",
          name: "不正料金",
          priceLabel,
          durationMinutes: 30,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true,
          idempotencyKey: `create-invalid-price-${typeof priceLabel}`
        });
        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "invalid_request" });
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 400 invalid_request when idempotencyKey is missing", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", {
          storeId: "store_test",
          name: "鍵なし",
          durationMinutes: 30,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true
        });

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "invalid_request" });
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 403 when caller has staff role", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "staff");
        seedStore(db, "store_test");
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", {
          storeId: "store_test",
          name: "新メニュー",
          durationMinutes: 45,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true,
          idempotencyKey: "staff-create-1"
        });

        expect(response.status).toBe(403);
        await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "forbidden" });
        // helper short-circuits before INSERT — confirm no service with our name was created
        const newlyCreated = (
          db.sqlite
            .prepare("SELECT COUNT(*) AS count FROM services WHERE name = ?")
            .get("新メニュー") as { count: number }
        ).count;
        expect(newlyCreated).toBe(0);
        // idempotency row must NOT be written — staff gate runs before idempotency lookup
        const idem = (
          db.sqlite
            .prepare("SELECT COUNT(*) AS count FROM idempotency_keys WHERE idempotency_key = 'staff-create-1'")
            .get() as { count: number }
        ).count;
        expect(idem).toBe(0);
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 404 store_not_found when the referenced store does not exist", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", {
          storeId: "nonexistent_store",
          name: "新メニュー",
          durationMinutes: 45,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true,
          idempotencyKey: "store-not-found-1"
        });

        expect(response.status).toBe(404);
        await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "store_not_found" });
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 400 invalid_request when durationMinutes is not a 5-minute multiple (booking slot interval)", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", {
          storeId: "store_test",
          name: "不整合な分数",
          durationMinutes: 47,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true,
          idempotencyKey: "duration-mod-1"
        });

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "invalid_request" });
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 400 invalid_request when bufferBeforeMinutes is nonzero (booking ignores buffer columns today)", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", {
          storeId: "store_test",
          name: "前バッファ要求",
          durationMinutes: 60,
          bufferBeforeMinutes: 10,
          bufferAfterMinutes: 0,
          active: true,
          idempotencyKey: "buffer-before-1"
        });

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "invalid_request" });
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 400 invalid_request when bufferAfterMinutes is nonzero (booking ignores buffer columns today)", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", {
          storeId: "store_test",
          name: "後バッファ要求",
          durationMinutes: 60,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 15,
          active: true,
          idempotencyKey: "buffer-after-1"
        });

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "invalid_request" });
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 400 invalid_request when name is missing", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", {
          storeId: "store_test",
          durationMinutes: 45,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true
        });

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "invalid_request" });
      } finally {
        db.sqlite.close();
      }
    });

    it("rejects a non-boolean mensMenu value", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/services", {
          storeId: "store_test",
          name: "不正メンズフラグ",
          durationMinutes: 45,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true,
          mensMenu: "true",
          idempotencyKey: "invalid-mens-menu"
        });

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "invalid_request" });
      } finally {
        db.sqlite.close();
      }
    });
  });

  describe("PUT /api/admin/settings/services/:id", () => {
    it("updates an existing service and writes audit_logs with before/after", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        seedService(db, { id: "svc_update", storeId: "store_test", name: "古い名前" });
        db.sqlite
          .prepare("UPDATE services SET price_label = '旧料金', price_amount = 10000, combo_price_amount = 8000, combo_with_prefix = '脱毛' WHERE id = 'svc_update'")
          .run();
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/services/svc_update", {
          storeId: "store_test",
          name: "新しい名前",
          priceLabel: null,
          priceAmount: 12_000,
          comboPriceAmount: 9_000,
          comboWithPrefix: "フェイシャル",
          durationMinutes: 90,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: false,
          mensMenu: true
        });

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toMatchObject({ ok: true, serviceId: "svc_update" });

        const row = db.sqlite
          .prepare("SELECT name, price_label, price_amount, combo_price_amount, combo_with_prefix, duration_minutes, active, mens_menu FROM services WHERE id = 'svc_update'")
          .get() as { name: string; price_label: string | null; price_amount: number | null; combo_price_amount: number | null; combo_with_prefix: string | null; duration_minutes: number; active: number; mens_menu: number };
        expect(row).toMatchObject({ name: "新しい名前", price_label: null, price_amount: 12_000, combo_price_amount: 9_000, combo_with_prefix: "フェイシャル", duration_minutes: 90, active: 0, mens_menu: 1 });

        const audit = db.sqlite
          .prepare("SELECT metadata_json FROM audit_logs WHERE action = 'settings.services.update'")
          .get() as { metadata_json: string };
        const meta = JSON.parse(audit.metadata_json);
        expect(meta.before).toMatchObject({ name: "古い名前", priceLabel: "旧料金", priceAmount: 10_000, comboPriceAmount: 8_000, comboWithPrefix: "脱毛", durationMinutes: 60, active: true, mensMenu: false });
        expect(meta.after).toMatchObject({ name: "新しい名前", priceLabel: null, priceAmount: 12_000, comboPriceAmount: 9_000, comboWithPrefix: "フェイシャル", durationMinutes: 90, active: false, mensMenu: true });
      } finally {
        db.sqlite.close();
      }
    });

    it("rejects a non-boolean mensMenu update", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        seedService(db, { id: "svc_invalid_mens", storeId: "store_test" });
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(
          db,
          access.token,
          "PUT",
          "/api/admin/settings/services/svc_invalid_mens",
          {
            storeId: "store_test",
            name: "不正メンズフラグ",
            durationMinutes: 60,
            bufferBeforeMinutes: 0,
            bufferAfterMinutes: 0,
            active: true,
            mensMenu: 1
          }
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "invalid_request" });
      } finally {
        db.sqlite.close();
      }
    });

    it("preserves priceLabel and audits the same before/after value when update omits it", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        seedService(db, { id: "svc_keep_price", storeId: "store_test", name: "変更前" });
        db.sqlite
          .prepare("UPDATE services SET price_label = '都度見積もり', price_amount = 10000, combo_price_amount = 8000, combo_with_prefix = '脱毛' WHERE id = 'svc_keep_price'")
          .run();
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/services/svc_keep_price", {
          storeId: "store_test",
          name: "変更後",
          durationMinutes: 60,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true
        });
        expect(response.status).toBe(200);

        const row = db.sqlite
          .prepare("SELECT price_label, price_amount, combo_price_amount, combo_with_prefix FROM services WHERE id = 'svc_keep_price'")
          .get() as { price_label: string | null; price_amount: number | null; combo_price_amount: number | null; combo_with_prefix: string | null };
        expect(row).toEqual({ price_label: "都度見積もり", price_amount: 10_000, combo_price_amount: 8_000, combo_with_prefix: "脱毛" });

        const audit = db.sqlite
          .prepare("SELECT metadata_json FROM audit_logs WHERE action = 'settings.services.update'")
          .get() as { metadata_json: string };
        const metadata = JSON.parse(audit.metadata_json);
        expect(metadata.before.priceLabel).toBe("都度見積もり");
        expect(metadata.after.priceLabel).toBe("都度見積もり");
        expect(metadata.before).toMatchObject({ priceAmount: 10_000, comboPriceAmount: 8_000, comboWithPrefix: "脱毛" });
        expect(metadata.after).toMatchObject({ priceAmount: 10_000, comboPriceAmount: 8_000, comboWithPrefix: "脱毛" });
      } finally {
        db.sqlite.close();
      }
    });

    it("updates one combo field while preserving the other final-state values", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        seedService(db, { id: "svc_partial_combo", storeId: "store_test" });
        db.sqlite
          .prepare("UPDATE services SET price_amount = 10000, combo_price_amount = 8000, combo_with_prefix = '脱毛' WHERE id = 'svc_partial_combo'")
          .run();
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/services/svc_partial_combo", {
          storeId: "store_test",
          name: "既存サービス",
          comboPriceAmount: 7_500,
          durationMinutes: 60,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true
        });
        expect(response.status).toBe(200);
        expect(db.sqlite.prepare("SELECT price_amount, combo_price_amount, combo_with_prefix FROM services WHERE id = 'svc_partial_combo'").get()).toEqual({
          price_amount: 10_000,
          combo_price_amount: 7_500,
          combo_with_prefix: "脱毛"
        });
      } finally {
        db.sqlite.close();
      }
    });

    it("requires clearing both combo fields when priceAmount is cleared", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        seedService(db, { id: "svc_clear_price", storeId: "store_test" });
        db.sqlite
          .prepare("UPDATE services SET price_amount = 10000, combo_price_amount = 8000, combo_with_prefix = '脱毛' WHERE id = 'svc_clear_price'")
          .run();
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));
        const base = {
          storeId: "store_test",
          name: "既存サービス",
          durationMinutes: 60,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true
        };

        const invalid = await adminRequest(db, access.token, "PUT", "/api/admin/settings/services/svc_clear_price", {
          ...base,
          priceAmount: null
        });
        expect(invalid.status).toBe(400);

        const valid = await adminRequest(db, access.token, "PUT", "/api/admin/settings/services/svc_clear_price", {
          ...base,
          priceAmount: null,
          comboPriceAmount: null,
          comboWithPrefix: null
        });
        expect(valid.status).toBe(200);
        expect(db.sqlite.prepare("SELECT price_amount, combo_price_amount, combo_with_prefix FROM services WHERE id = 'svc_clear_price'").get()).toEqual({
          price_amount: null,
          combo_price_amount: null,
          combo_with_prefix: null
        });
      } finally {
        db.sqlite.close();
      }
    });

    it("rejects an orphan combo tuple in the merged update state", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        seedService(db, { id: "svc_orphan_combo", storeId: "store_test" });
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));
        const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/services/svc_orphan_combo", {
          storeId: "store_test",
          name: "既存サービス",
          priceAmount: 10_000,
          comboWithPrefix: "脱毛",
          durationMinutes: 60,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true
        });
        expect(response.status).toBe(400);
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 404 not_found when service does not exist", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/services/missing_svc", {
          storeId: "store_test",
          name: "別名",
          durationMinutes: 60,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true
        });

        expect(response.status).toBe(404);
        await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "not_found" });
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 400 invalid_request when PUT body omits active (no silent reactivation via partial body)", async () => {
      // Regression: a PUT that omits `active` must not silently default to
      // active=true; an operator editing other fields on an inactive service
      // would otherwise unintentionally reactivate it.
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        seedService(db, { id: "svc_inactive", storeId: "store_test", active: 0 });
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/services/svc_inactive", {
          storeId: "store_test",
          name: "名前だけ変える",
          durationMinutes: 60,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0
          // intentionally no `active` field
        });

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "invalid_request" });
        const row = db.sqlite
          .prepare("SELECT active, name FROM services WHERE id = 'svc_inactive'")
          .get() as { active: number; name: string };
        expect(row).toMatchObject({ active: 0, name: "既存サービス" });
      } finally {
        db.sqlite.close();
      }
    });

    it.each([
      ["longer than 80 characters", "料".repeat(81)],
      ["not a string or null", 123]
    ])("returns 400 invalid_request when update priceLabel is %s", async (_case, priceLabel) => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        seedService(db, { id: "svc_invalid_price", storeId: "store_test" });
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/services/svc_invalid_price", {
          storeId: "store_test",
          name: "不正料金更新",
          priceLabel,
          durationMinutes: 60,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true
        });
        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "invalid_request" });
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 409 has_future_reservations when PUT tries to deactivate a service with future bookings", async () => {
      // Tier C.3 4b regression guard: setting active=false through PUT must be
      // treated as soft-delete and refused while pending_approval or confirmed
      // future reservations still reference the service. Otherwise the operator
      // could bypass the DELETE has_future_reservations guard.
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        seedService(db, { id: "svc_put_busy", storeId: "store_test" });
        seedFutureReservation(db, {
          id: "rsv_put_pending",
          storeId: "store_test",
          serviceId: "svc_put_busy",
          startAt: futureSlot,
          status: "pending_approval"
        });
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/services/svc_put_busy", {
          storeId: "store_test",
          name: "停止しようとする",
          durationMinutes: 60,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: false
        });

        expect(response.status).toBe(409);
        await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "has_future_reservations" });
        const row = db.sqlite
          .prepare("SELECT active, name FROM services WHERE id = 'svc_put_busy'")
          .get() as { active: number; name: string };
        // unchanged — guard refused before write
        expect(row).toMatchObject({ active: 1, name: "既存サービス" });
      } finally {
        db.sqlite.close();
      }
    });

    it("allows PUT with active=true to succeed even when future reservations exist (guard only on deactivation)", async () => {
      // The guard must not block routine edits that keep the service active —
      // only the active true→false transition has the soft-delete semantics.
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        seedService(db, { id: "svc_put_busy_active", storeId: "store_test" });
        seedFutureReservation(db, {
          id: "rsv_put_busy_active",
          storeId: "store_test",
          serviceId: "svc_put_busy_active",
          startAt: futureSlot
        });
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/services/svc_put_busy_active", {
          storeId: "store_test",
          name: "名前だけ更新",
          durationMinutes: 75,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: true
        });

        expect(response.status).toBe(200);
        const row = db.sqlite
          .prepare("SELECT active, name, duration_minutes FROM services WHERE id = 'svc_put_busy_active'")
          .get() as { active: number; name: string; duration_minutes: number };
        expect(row).toMatchObject({ active: 1, name: "名前だけ更新", duration_minutes: 75 });
      } finally {
        db.sqlite.close();
      }
    });
  });

  describe("DELETE /api/admin/settings/services/:id", () => {
    it("soft-deletes a service when no future reservations are bound, writes audit_logs", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        seedService(db, { id: "svc_delete", storeId: "store_test" });
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "DELETE", "/api/admin/settings/services/svc_delete");

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toMatchObject({ ok: true, serviceId: "svc_delete" });

        const row = db.sqlite
          .prepare("SELECT active FROM services WHERE id = 'svc_delete'")
          .get() as { active: number };
        expect(row.active).toBe(0);

        const audit = db.sqlite
          .prepare("SELECT metadata_json FROM audit_logs WHERE action = 'settings.services.delete'")
          .get() as { metadata_json: string };
        expect(JSON.parse(audit.metadata_json)).toMatchObject({
          serviceId: "svc_delete",
          softDelete: true,
          adminRole: "owner"
        });
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 404 not_found when the service does not exist", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "DELETE", "/api/admin/settings/services/missing");

        expect(response.status).toBe(404);
        await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "not_found" });
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 409 has_future_reservations when future bookings still reference the service", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        seedService(db, { id: "svc_busy", storeId: "store_test" });
        seedFutureReservation(db, {
          id: "rsv_future",
          storeId: "store_test",
          serviceId: "svc_busy",
          startAt: futureSlot
        });
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "DELETE", "/api/admin/settings/services/svc_busy");

        expect(response.status).toBe(409);
        await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "has_future_reservations" });
        const row = db.sqlite
          .prepare("SELECT active FROM services WHERE id = 'svc_busy'")
          .get() as { active: number };
        // service must remain active — delete refused before any write
        expect(row.active).toBe(1);
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 409 when PUT tries to deactivate a service used as the 2nd menu of a multi-menu future reservation", async () => {
      // Same secondary-menu fixture as the DELETE junction guard test — make
      // sure the PUT path also returns 409 via shared
      // countFutureReservationsForService rather than letting the SQL guard
      // be the only defence on the update route.
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        seedService(db, { id: "svc_put_primary", storeId: "store_test", name: "1st menu" });
        seedService(db, { id: "svc_put_secondary", storeId: "store_test", name: "2nd menu" });
        seedFutureReservation(db, {
          id: "rsv_put_multi",
          storeId: "store_test",
          serviceId: "svc_put_primary",
          startAt: futureSlot
        });
        seedReservationServiceJunction(db, {
          reservationId: "rsv_put_multi",
          serviceId: "svc_put_secondary"
        });
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/services/svc_put_secondary", {
          storeId: "store_test",
          name: "停止しようとする",
          durationMinutes: 60,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          active: false
        });

        expect(response.status).toBe(409);
        await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "has_future_reservations" });
        const row = db.sqlite
          .prepare("SELECT active FROM services WHERE id = 'svc_put_secondary'")
          .get() as { active: number };
        expect(row.active).toBe(1);
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 409 has_future_reservations when the service is the 2nd menu of a multi-menu future reservation (junction-table guard)", async () => {
      // Multi-menu reservations only set reservations.service_id to the first
      // selected menu; the 2nd+ live in reservation_services. Without joining
      // the junction table, the soft-delete guard would miss outstanding
      // bookings that reference the service as a secondary menu.
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        seedService(db, { id: "svc_primary_menu", storeId: "store_test", name: "1st menu" });
        seedService(db, { id: "svc_secondary_menu", storeId: "store_test", name: "2nd menu" });
        seedFutureReservation(db, {
          id: "rsv_multi_menu",
          storeId: "store_test",
          serviceId: "svc_primary_menu",
          startAt: futureSlot
        });
        seedReservationServiceJunction(db, {
          reservationId: "rsv_multi_menu",
          serviceId: "svc_secondary_menu"
        });
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "DELETE", "/api/admin/settings/services/svc_secondary_menu");

        expect(response.status).toBe(409);
        await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "has_future_reservations" });
        const row = db.sqlite
          .prepare("SELECT active FROM services WHERE id = 'svc_secondary_menu'")
          .get() as { active: number };
        expect(row.active).toBe(1);
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 409 has_future_reservations when only pending_approval reservations exist", async () => {
      // pending_approval is the real status name from the transitions module;
      // an earlier draft used 'pending' which silently never matched and let
      // soft-delete succeed despite outstanding approval-awaiting bookings.
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        seedService(db, { id: "svc_pending_busy", storeId: "store_test" });
        seedFutureReservation(db, {
          id: "rsv_pending_busy",
          storeId: "store_test",
          serviceId: "svc_pending_busy",
          startAt: futureSlot,
          status: "pending_approval"
        });
        const access = createAccessJwtFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));

        const response = await adminRequest(db, access.token, "DELETE", "/api/admin/settings/services/svc_pending_busy");

        expect(response.status).toBe(409);
        await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "has_future_reservations" });
        const row = db.sqlite
          .prepare("SELECT active FROM services WHERE id = 'svc_pending_busy'")
          .get() as { active: number };
        expect(row.active).toBe(1);
      } finally {
        db.sqlite.close();
      }
    });
  });

  it("returns 403 when no Access JWT is supplied", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db, "store_test");
      const response = await adminRequest(db, null, "POST", "/api/admin/settings/services", {
        storeId: "store_test",
        name: "新メニュー",
        durationMinutes: 30,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        active: true,
        idempotencyKey: "no-jwt-1"
      });
      expect(response.status).toBe(403);
      await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "forbidden" });
    } finally {
      db.sqlite.close();
    }
  });
});
