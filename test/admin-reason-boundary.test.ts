import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { createAccessJwksFetchMock, createAccessJwtFixture, insertAdminUser } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const teamDomain = "https://team.example.cloudflareaccess.com";
const audience = "reason-boundary-aud";
const access = createAccessJwtFixture({
  issuer: teamDomain, audience, keyId: "reason-boundary-key",
  claims: { email: "reason@example.test", sub: "reason-owner" }
});
const actions = ["reject", "block", "unblock", "archive", "unarchive", "cancel"] as const;

describe("admin action reason boundary", () => {
  let db: SqliteD1Database;

  beforeEach(() => {
    db = createMigratedSqliteD1();
    insertAdminUser(db, { id: "reason-owner", email: "reason@example.test", accessSubject: "reason-owner", role: "owner" });
    vi.stubGlobal("fetch", createAccessJwksFetchMock(teamDomain, access.jwk));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    db.sqlite.close();
  });

  const request = (action: typeof actions[number], reason: unknown) => {
    db.sqlite.prepare("INSERT INTO customers (id, display_name, block_status, archived_at) VALUES ('reason-customer', 'テスト顧客', ?, ?)")
      .run(action === "unblock" ? "blocked" : "active", action === "unarchive" ? "2026-01-01T00:00:00.000Z" : null);
    if (action === "reject") {
      db.sqlite.exec(`INSERT INTO reservations (
        id, store_id, service_id, customer_id, resource_id, source, status,
        start_at, end_at, duration_minutes, idempotency_key
      ) VALUES ('reason-reservation', 'kyoto', 'service_kyoto_default_60', 'reason-customer',
        'resource_kyoto_calendar', 'web_line', 'pending_approval',
        '2027-06-15T01:00:00.000Z', '2027-06-15T02:00:00.000Z', 60, 'reason-reservation-key')`);
    }
    if (action === "cancel") {
      db.sqlite.exec(`INSERT INTO external_blocks (id, store_id, resource_id, source, start_at, end_at, status)
        VALUES ('reason-block', 'kyoto', 'resource_kyoto_calendar', 'admin_block',
          '2027-06-15T01:00:00.000Z', '2027-06-15T02:00:00.000Z', 'active')`);
    }
    const target = action === "reject" ? "reservations/reason-reservation"
      : action === "cancel" ? "external-blocks/reason-block" : "customers/reason-customer";
    return createApp().request(`/api/admin/${target}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": access.token },
      body: JSON.stringify({ idempotencyKey: "reason-action-key", reason })
    }, { DB: db, ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: audience });
  };

  it.each(actions)("rejects a 501-character reason before %s", async (action) => {
    const response = await request(action, "あ".repeat(501));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ ok: false, reason: "invalid_request" });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_logs").get()).toEqual({ count: 0 });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_keys").get()).toEqual({ count: 0 });
    expect(db.sqlite.prepare("SELECT block_status, archived_at FROM customers WHERE id = 'reason-customer'").get())
      .toEqual({ block_status: action === "unblock" ? "blocked" : "active", archived_at: action === "unarchive" ? "2026-01-01T00:00:00.000Z" : null });
    if (action === "reject") {
      expect(db.sqlite.prepare("SELECT status FROM reservations WHERE id = 'reason-reservation'").get())
        .toEqual({ status: "pending_approval" });
    }
    if (action === "cancel") {
      expect(db.sqlite.prepare("SELECT status FROM external_blocks WHERE id = 'reason-block'").get())
        .toEqual({ status: "active" });
    }
  });

  it.each(actions)("preserves a 500-character reason for %s", async (action) => {
    const reason = "あ".repeat(500);
    const response = await request(action, reason);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    const audit = db.sqlite.prepare("SELECT metadata_json FROM audit_logs ORDER BY rowid DESC LIMIT 1").get() as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json).reason).toBe(reason);
  });

  it.each([undefined, null, "", 42])("preserves %j as an omitted optional reason", async (reason) => {
    const response = await request("reject", reason);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    const audit = db.sqlite.prepare("SELECT metadata_json FROM audit_logs ORDER BY rowid DESC LIMIT 1").get() as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json).reason).toBeNull();
  });
});
