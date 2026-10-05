import { afterEach, describe, expect, it, vi } from "vitest";

import { getAdminSettingsSnapshot } from "../src/admin/operations";
import { createApp } from "../src/app";
import { createAccessJwksFetchMock, createAccessJwtFixture } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// issue #536: store_closures global LIMIT 200 then store filter dropped own-store rows.

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-settings-closures-limit-aud";
const ADMIN_EMAIL = "staff-closures-limit@example.com";
const ADMIN_ACCESS_SUBJECT = "access-subject-closures-limit";
const ACCESS_KEY_ID = "closures-limit-key-1";

const asD1 = (db: SqliteD1Database) => db as unknown as D1Database;

const isoOffset = (utcMs: number): string => new Date(utcMs).toISOString().replace("Z", "+00:00");

const insertClosure = (
  db: SqliteD1Database,
  options: { id: string; storeId: string; startsAtMs: number }
) => {
  const startsAt = isoOffset(options.startsAtMs);
  const endsAt = isoOffset(options.startsAtMs + 3_600_000);
  db.sqlite
    .prepare(
      `INSERT INTO store_closures (id, store_id, starts_at, ends_at, reason, source, created_at)
       VALUES (?, ?, ?, ?, ?, 'admin', '2026-01-01T00:00:00.000Z')`
    )
    .run(options.id, options.storeId, startsAt, endsAt, options.id);
};

const insertStaffAdmin = (db: SqliteD1Database, storeId: string) => {
  db.sqlite
    .prepare(
      `INSERT INTO staff_members (id, store_id, display_name, role, active)
       VALUES ('sm_closures_limit', ?, 'Staff Closures Limit', 'staff', 1)`
    )
    .run(storeId);
  db.sqlite
    .prepare(
      `INSERT INTO admin_users (id, email, access_subject, role, active, staff_member_id, updated_at)
       VALUES ('admin_closures_limit', ?, ?, 'staff', 1, 'sm_closures_limit', '2026-01-01T00:00:00.000Z')`
    )
    .run(ADMIN_EMAIL, ADMIN_ACCESS_SUBJECT);
};

const adminGetSettings = (db: SqliteD1Database, token: string) => {
  const app = createApp();
  return app.request(
    "/api/admin/settings",
    {
      method: "GET",
      headers: { "Cf-Access-Jwt-Assertion": token }
    },
    {
      ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
      ACCESS_AUD,
      DB: db
    }
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getAdminSettingsSnapshot store_closures LIMIT scope (issue #536)", () => {
  it("unscoped snapshot keeps newest 200 per store and drops the 201st-oldest", async () => {
    const db = createMigratedSqliteD1();
    const base = Date.parse("2028-06-15T00:00:00.000Z");

    for (let i = 0; i < 201; i++) {
      insertClosure(db, {
        id: `cls_osaka_${i}`,
        storeId: "osaka",
        startsAtMs: base + i * 60_000
      });
    }
    insertClosure(db, {
      id: "cls_nagoya_old",
      storeId: "nagoya",
      startsAtMs: Date.parse("2020-01-01T00:00:00.000Z")
    });

    const unscoped = await getAdminSettingsSnapshot({ db: asD1(db) });
    const osakaIds = unscoped.settings.closures.filter((c) => c.storeId === "osaka").map((c) => c.id);
    expect(osakaIds).toHaveLength(200);
    expect(osakaIds).toContain("cls_osaka_200");
    expect(osakaIds).not.toContain("cls_osaka_0");
    expect(unscoped.settings.closures.some((c) => c.id === "cls_nagoya_old")).toBe(true);
  });

  it("GET /api/admin/settings as staff scopes LIMIT via storeId (route wiring regression)", async () => {
    const access = createAccessJwtFixture({
      issuer: TEAM_DOMAIN,
      audience: ACCESS_AUD,
      keyId: ACCESS_KEY_ID,
      claims: { email: ADMIN_EMAIL, sub: ADMIN_ACCESS_SUBJECT }
    });
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

    const db = createMigratedSqliteD1();
    insertStaffAdmin(db, "nagoya");

    const base = Date.parse("2029-01-01T00:00:00.000Z");
    for (let i = 0; i < 200; i++) {
      insertClosure(db, {
        id: `cls_osaka_new_${i}`,
        storeId: "osaka",
        startsAtMs: base + i * 60_000
      });
    }
    insertClosure(db, {
      id: "cls_nagoya_own",
      storeId: "nagoya",
      startsAtMs: Date.parse("2020-01-01T00:00:00.000Z")
    });

    const response = await adminGetSettings(db, access.token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      settings: { closures: Array<{ id: string; storeId: string }> };
    };

    expect(body.ok).toBe(true);
    const closureIds = body.settings.closures.map((c) => c.id);
    expect(closureIds).toContain("cls_nagoya_own");
    expect(body.settings.closures.every((c) => c.storeId === "nagoya")).toBe(true);
    expect(closureIds.some((id) => id.startsWith("cls_osaka_new_"))).toBe(false);
  });
});
