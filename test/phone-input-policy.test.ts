import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { sha256Hex } from "../src/admin/settings-common";
import { createAccessJwtFixture, createAccessJwksFetchMock, insertAdminUser, type AdminRole } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const team = "https://phone-policy.cloudflareaccess.com";
const audience = "phone-policy";
const friend = "U" + "a".repeat(32);
const access = createAccessJwtFixture({ issuer: team, audience, keyId: "phone-policy", claims: {
  email: "phone@example.com", sub: "phone-policy", iat: 1_700_000_000, nbf: 1_700_000_000, exp: 2_000_000_000
} });

describe("new phone input policy at authenticated admin APIs", () => {
  let db: SqliteD1Database;
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-09T00:00:00.000Z"));
    db = createMigratedSqliteD1();
    insertAdminUser(db, { id: "phone_admin", email: "phone@example.com", accessSubject: "phone-policy", role: "owner", staffMemberId: "staff_owner_kyoto" });
    db.sqlite.exec(`INSERT INTO customers (id, display_name, created_store_id) VALUES ('phone_customer', '架空顧客', 'kyoto');
      INSERT INTO line_friend_directory (channel_id, line_user_id, display_name, profile_status, first_seen_at)
      VALUES ('phone-channel', '${friend}', '架空友だち', 'fetched', '2026-01-01');`);
    vi.stubGlobal("fetch", createAccessJwksFetchMock(team, access.jwk));
  });
  afterEach(() => { db.sqlite.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const request = (path: string, body: unknown, method = "POST", authenticated = true) => createApp().request(path, {
    method, headers: { "Content-Type": "application/json", ...(authenticated ? { "Cf-Access-Jwt-Assertion": access.token } : {}) },
    body: JSON.stringify(body)
  }, { DB: db, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: audience, LINE_CHANNEL_ID: "phone-channel" });

  const addCustomer = (phone: string | null, key = "phone-create") => request("/api/admin/customers", {
    idempotencyKey: key, displayName: "架空 新規", phone
  });

  const operations = [
    { name: "manual customer", run: addCustomer },
    { name: "profile", run: (phone: string | null) => request("/api/admin/customers/phone_customer/profile", { phone }, "PATCH") },
    { name: "friend link", run: (phone: string | null) => request(`/api/admin/line-friends/${friend}/link`, {
      mode: "new", storeId: "kyoto", newCustomer: { displayName: "架空 新規", phone }
    }) },
    { name: "admin booking", run: (phone: string | null) => request("/api/admin/reservations", {
      idempotencyKey: "phone-booking", source: "phone_admin", storeId: "kyoto", serviceIds: ["service_kyoto_default_60"],
      resourceId: "resource_kyoto_calendar", startAt: "2026-06-01T03:00:00.000Z", customer: { displayName: "架空 新規", phone }
    }) }
  ];
  const businessState = () => Object.fromEntries([
    "customers", "line_identities", "reservations", "slot_locks", "customer_time_locks", "notification_jobs", "calendar_sync_jobs", "audit_logs", "idempotency_keys"
  ].map(table => [table, db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));

  for (const operation of operations.slice(1)) {
    it.each(["staff", "owner", "system_admin"] satisfies AdminRole[])(`${operation.name} rejects padded input for %s without partial writes`, async role => {
      db.sqlite.prepare("UPDATE admin_users SET role = ? WHERE id='phone_admin'").run(role);
      const before = businessState();
      const result = await operation.run("00312345678");
      expect(result.status).toBe(operation.name === "friend link" && role === "staff" ? 403 : 400);
      expect(businessState()).toEqual(before);
    });
  }

  for (const operation of operations) {
    it.each(["009012345678", "0009012345678", "+0819012345678", "810819012345678", "81912345678", "010819012345678", "+1234567890123456", "+8125551234"])(`${operation.name} rejects new ambiguous or malformed input %s`, async phone => {
      const before = businessState();
      const result = await operation.run(phone);
      expect(result.status).toBe(400);
      expect(businessState()).toEqual(before);
    });
  }

  for (const operation of operations.slice(1)) {
    it.each([["+81 90-1234-5678", "09012345678"], ["+1 812-555-1234", "+18125551234"]])(`${operation.name} preserves accepted phone identity %s`, async (phone, canonical) => {
      const result = await operation.run(phone);
      expect(result.status).toBeLessThan(300);
      const body = await result.json() as { customerId?: string; reservationId?: string };
      const customerId = operation.name === "profile" ? "phone_customer" : operation.name === "admin booking"
        ? (db.sqlite.prepare("SELECT customer_id FROM reservations WHERE id=?").get(body.reservationId!) as { customer_id: string }).customer_id
        : body.customerId;
      expect(db.sqlite.prepare("SELECT phone_normalized, phone_hash FROM customers WHERE id=?").get(customerId!))
        .toEqual({ phone_normalized: canonical, phone_hash: await sha256Hex(canonical) });
    });
  }

  it("replays a successful legacy manual customer input before the new-write gate", async () => {
    const requestHash = await sha256Hex(JSON.stringify({ action: "create_customer", displayName: "架空 新規", displayNameKana: null, phoneNormalized: "81912345678" }));
    db.sqlite.prepare(`INSERT INTO idempotency_keys (id, scope, idempotency_key, request_hash, status, target_type, target_id, expires_at)
      VALUES ('legacy_key', 'admin_action', 'phone-create', ?, 'succeeded', 'customer', 'phone_customer', '2026-05-10T00:00:00.000Z')`).run(requestHash);
    const before = businessState();
    const result = await addCustomer("81912345678");
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ ok: true, customerId: "phone_customer", replayed: true });
    expect(businessState()).toEqual(before);
  });

  const publicRequest = (phone?: string) => ({
    idToken: "test-id", lineAccessToken: "test-access", turnstileToken: "test-turnstile", idempotencyKey: "public-phone",
    storeId: "kyoto", serviceId: "service_kyoto_default_60", resourceId: "resource_kyoto_calendar", startAt: "2026-06-01T03:00:00.000Z",
    ...(phone === undefined ? {} : { customer: { displayName: "架空 新規", phone } }),
    consents: { noticeVersion: "notice-terms-2026-06", cancellationPolicyVersion: "cancel-2026-08-31", privacyPolicyVersion: "privacy-2026-06" }
  });
  const publicBooking = (phone?: string) => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true }))
      .mockResolvedValueOnce(Response.json({ sub: "phone-line-user", aud: "phone-channel", exp: 2_000_000_000, iat: 1_700_000_000 }))
      .mockResolvedValueOnce(Response.json({ userId: "phone-line-user" }))
      .mockResolvedValueOnce(Response.json({ friendFlag: true })));
    return createApp().request("/api/public/reservations", {
      method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.10" }, body: JSON.stringify(publicRequest(phone))
    }, { DB: db, LINE_CHANNEL_ID: "phone-channel", TURNSTILE_SECRET_KEY: "test-secret" });
  };

  it.each(["00312345678", "009012345678", "0009012345678", "+0819012345678", "810819012345678", "81912345678", "010819012345678", "+1234567890123456", "+8125551234"])("public booking rejects new phone input %s without business writes", async phone => {
    const before = businessState();
    const response = await publicBooking(phone);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, reason: "invalid_request" });
    expect(businessState()).toEqual(before);
  });

  it.each([["+81 90-1234-5678", "09012345678"], ["+1 812-555-1234", "+18125551234"]])("public booking preserves accepted phone identity %s", async (phone, canonical) => {
    const response = await publicBooking(phone);
    expect(response.status).toBe(201);
    const body = await response.json() as { reservationId: string };
    expect(db.sqlite.prepare(`SELECT c.phone_normalized, c.phone_hash FROM customers c JOIN reservations r ON r.customer_id=c.id WHERE r.id=?`).get(body.reservationId))
      .toEqual({ phone_normalized: canonical, phone_hash: await sha256Hex(canonical) });
  });

  it("keeps an existing recognized legacy contact usable without new phone input", async () => {
    db.sqlite.prepare("UPDATE customers SET phone_normalized='81912345678', phone_hash=? WHERE id='phone_customer'").run(await sha256Hex("81912345678"));
    db.sqlite.exec(`INSERT INTO line_identities (id, customer_id, channel_id, line_user_id, official_friend_status)
      VALUES ('legacy-line', 'phone_customer', 'phone-channel', 'phone-line-user', 'friend')`);
    const response = await publicBooking();
    expect(response.status).toBe(201);
    expect(db.sqlite.prepare("SELECT phone_normalized FROM customers WHERE id='phone_customer'").get()).toEqual({ phone_normalized: "81912345678" });
  });

  it("replays a legacy admin booking without changing its phone locks", async () => {
    const response = await operations[3].run("09012345678");
    expect(response.status).toBe(201);
    const { reservationId } = await response.json() as { reservationId: string };
    const legacyPhone = "81912345678";
    const phoneHash = await sha256Hex(legacyPhone);
    db.sqlite.prepare("UPDATE customers SET phone_normalized=?, phone_hash=? WHERE id=(SELECT customer_id FROM reservations WHERE id=?)").run(legacyPhone, phoneHash, reservationId);
    db.sqlite.prepare("UPDATE customer_time_locks SET phone_hash=? WHERE owner_id=?").run(phoneHash, reservationId);
    // Golden request identity from the pre-policy booking contract.
    const requestHash = await sha256Hex(JSON.stringify({ source: "phone_admin", storeId: "kyoto", serviceId: "service_kyoto_default_60",
      resourceId: "resource_kyoto_calendar", startAt: "2026-06-01T03:00:00.000Z", origin: null, customerId: null,
      customer: { displayName: "架空 新規", displayNameKana: null, phone: legacyPhone } }));
    db.sqlite.prepare("UPDATE idempotency_keys SET request_hash=? WHERE scope='admin_action' AND idempotency_key='phone-booking'").run(requestHash);
    const before = businessState();
    const replay = await operations[3].run(legacyPhone);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ ok: true, reservationId, replayed: true });
    expect(businessState()).toEqual(before);
  });

  it.each(["staff", "owner", "system_admin"] satisfies AdminRole[])("keeps customerId booking usable for a legacy contact as %s", async role => {
    db.sqlite.prepare("UPDATE admin_users SET role=? WHERE id='phone_admin'").run(role);
    const phoneHash = await sha256Hex("81912345678");
    db.sqlite.prepare("UPDATE customers SET phone_normalized='81912345678', phone_hash=? WHERE id='phone_customer'").run(phoneHash);
    const response = await request("/api/admin/reservations", {
      idempotencyKey: "legacy-customer-id", source: "phone_admin", storeId: "kyoto", serviceIds: ["service_kyoto_default_60"],
      resourceId: "resource_kyoto_calendar", startAt: "2026-06-01T03:00:00.000Z", customerId: "phone_customer"
    });
    expect(response.status).toBe(201);
    expect(db.sqlite.prepare("SELECT DISTINCT phone_hash FROM customer_time_locks").all()).toEqual([{ phone_hash: phoneHash }]);
    expect(db.sqlite.prepare("SELECT phone_normalized FROM customers WHERE id='phone_customer'").get()).toEqual({ phone_normalized: "81912345678" });
  });

  it("replays the pre-policy public request identity for legacy contact input", async () => {
    const response = await publicBooking("09012345678");
    expect(response.status).toBe(201);
    const { reservationId } = await response.json() as { reservationId: string };
    const legacyPhone = "81912345678";
    db.sqlite.prepare("UPDATE customers SET phone_normalized=?, phone_hash=? WHERE id=(SELECT customer_id FROM reservations WHERE id=?)")
      .run(legacyPhone, await sha256Hex(legacyPhone), reservationId);
    const legacyRequest = publicRequest(legacyPhone);
    const requestHash = await sha256Hex(JSON.stringify({ storeId: legacyRequest.storeId, serviceId: legacyRequest.serviceId,
      serviceIds: [legacyRequest.serviceId], resourceId: legacyRequest.resourceId, startAt: legacyRequest.startAt,
      customer: { displayName: "架空 新規", displayNameKana: null, phone: legacyPhone }, consents: legacyRequest.consents,
      line: { lineUserId: "phone-line-user", channelId: "phone-channel" } }));
    db.sqlite.prepare("UPDATE idempotency_keys SET request_hash=? WHERE scope='public_submit'").run(requestHash);
    const before = businessState();
    const replay = await publicBooking(legacyPhone);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ ok: true, reservationId, replayed: true });
    expect(businessState()).toEqual(before);
  });

  it.each(["public", "admin"])("retains same-number blocking for %s booking through a Japanese alias", async mode => {
    db.sqlite.prepare("UPDATE customers SET phone_normalized='09012345678', phone_hash=?, block_status='blocked' WHERE id='phone_customer'")
      .run(await sha256Hex("09012345678"));
    const before = businessState();
    const response = mode === "public" ? await publicBooking("+81 90-1234-5678") : await operations[3].run("+81 90-1234-5678");
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(businessState()).toEqual(before);
  });

  it.each(["staff", "owner", "system_admin"] satisfies AdminRole[])("manual customer registration rejects zero-padding for %s without writing", async role => {
    db.sqlite.prepare("UPDATE admin_users SET role = ? WHERE id='phone_admin'").run(role);
    const before = db.sqlite.prepare("SELECT COUNT(*) AS n FROM customers").get();
    const result = await addCustomer("00312345678");
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ ok: false, reason: "invalid_request" });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM customers").get()).toEqual(before);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs").get()).toEqual({ n: 0 });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get()).toEqual({ n: 0 });
  });

  it("requires Access before accepting new contact input", async () => {
    expect((await request("/api/admin/customers", { idempotencyKey: "unauthenticated", displayName: "架空", phone: "09012345678" }, "POST", false)).status).toBe(403);
  });

  it.each([
    ["090-1234-5678", "09012345678"], ["+81 3-1234-5678", "0312345678"],
    ["0081 90-1234-5678", "09012345678"], ["819012345678", "09012345678"],
    ["+1 812-555-1234", "+18125551234"], ["+44 20-1234-5678", "+442012345678"],
    ["+12345678", "+12345678"], ["+123456789012345", "+123456789012345"], [null, null]
  ])("stores accepted manual input %j with unchanged identity", async (phone, canonical) => {
    const result = await addCustomer(phone);
    expect(result.status).toBe(201);
    const body = await result.json() as { customerId: string };
    expect(db.sqlite.prepare("SELECT phone_normalized, phone_hash FROM customers WHERE id=?").get(body.customerId))
      .toEqual({ phone_normalized: canonical, phone_hash: canonical ? await sha256Hex(canonical) : null });
  });
});
