import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { createAccessJwksFetchMock, createAccessJwtFixture, insertAdminUser } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "conflict-reasons-aud";
const access = createAccessJwtFixture({
  issuer: TEAM_DOMAIN,
  audience: ACCESS_AUD,
  keyId: "conflict-reasons-key",
  claims: { email: "owner@example.test", sub: "conflict-reasons-owner" }
});

const actions = [
  { path: "/sync/all-day-candidates/conflict_reason/approve", type: "google_all_day_event", nested: true },
  { path: "/sync/all-day-candidates/conflict_reason/reject", type: "google_all_day_event", nested: false },
  { path: "/sync/conflicts/conflict_reason/approve-cancel", type: "reservation_event_deleted", nested: false },
  { path: "/sync/conflicts/conflict_reason/reject-delete", type: "reservation_event_deleted", nested: false }
] as const;

describe("conflict action reason validation", () => {
  let db: SqliteD1Database;

  beforeEach(() => {
    db = createMigratedSqliteD1();
    insertAdminUser(db, {
      id: "conflict-reasons-owner",
      email: "owner@example.test",
      accessSubject: "conflict-reasons-owner",
      role: "owner"
    });
    db.sqlite.exec("UPDATE stores SET google_calendar_id = 'calendar@example.invalid' WHERE id = 'kyoto'");
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.sqlite.close();
  });

  const seedConflict = (type: typeof actions[number]["type"]) => {
    if (type === "reservation_event_deleted") {
      db.sqlite.exec(`
        INSERT INTO customers (id, display_name) VALUES ('reason_customer', 'テスト顧客');
        INSERT INTO reservations (
          id, store_id, service_id, customer_id, resource_id, source, status,
          start_at, end_at, duration_minutes, idempotency_key
        ) VALUES (
          'reason_reservation', 'kyoto', 'service_kyoto_default_60', 'reason_customer',
          'resource_kyoto_calendar', 'admin', 'confirmed',
          '2027-06-15T01:00:00.000Z', '2027-06-15T02:00:00.000Z', 60, 'reason_reservation_key'
        );
      `);
    }
    db.sqlite.prepare(`
      INSERT INTO google_calendar_conflicts (
        id, store_id, calendar_id, google_event_id, reservation_id,
        conflict_type, google_safe_snapshot_json, resolution_status
      ) VALUES ('conflict_reason', 'kyoto', 'calendar@example.invalid', 'reason_event', ?, ?, ?, 'open')
    `).run(
      type === "reservation_event_deleted" ? "reason_reservation" : null,
      type,
      JSON.stringify({ start_at: "2027-06-15T00:00:00.000Z", end_at: "2027-06-16T00:00:00.000Z" })
    );
  };

  const request = (action: typeof actions[number], reason: string | null | undefined) => createApp().request(
    `/api/admin${action.path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": access.token },
      body: JSON.stringify({
        idempotencyKey: "conflict_reason_key",
        ...(action.nested ? { closureScope: { reason } } : { reason })
      })
    },
    { DB: db, ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD }
  );

  it.each(actions)("rejects a 501-character reason before resolving $path", async (action) => {
    seedConflict(action.type);

    const response = await request(action, "あ".repeat(501));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ ok: false, reason: "invalid_request" });
    expect(db.sqlite.prepare(
      "SELECT resolution_status FROM google_calendar_conflicts WHERE id = 'conflict_reason'"
    ).get()).toEqual({ resolution_status: "open" });
    for (const table of ["audit_logs", "idempotency_keys", "store_closures", "calendar_sync_jobs", "notification_jobs"]) {
      expect(db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    if (action.type === "reservation_event_deleted") {
      expect(db.sqlite.prepare("SELECT status FROM reservations WHERE id = 'reason_reservation'").get())
        .toEqual({ status: "confirmed" });
    }
  });

  it.each(actions)("preserves a 500-character reason in the audit log for $path", async (action) => {
    seedConflict(action.type);
    const reason = "あ".repeat(500);

    const response = await request(action, reason);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    const audit = db.sqlite.prepare(
      "SELECT metadata_json FROM audit_logs WHERE target_id = 'conflict_reason'"
    ).get() as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json).reason).toBe(reason);
  });

  describe.each(actions)("optional reasons for $path", (action) => {
    it.each([undefined, null, ""])("accepts %j as an omitted reason", async (reason) => {
      seedConflict(action.type);

      const response = await request(action, reason);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ok: true });
    });
  });
});
