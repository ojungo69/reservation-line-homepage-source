import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import {
  createAccessJwksFetchMock,
  createAccessJwtFixture,
  createAccessSigningKey,
  insertAdminUser,
  type AccessJwtFixture,
} from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// The redesigned calendar (specs/008) must stay off in production even when an
// old "true" survives a deploy that keeps earlier vars, so the server decides
// from ENVIRONMENT as well as from the value.

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-calendar-v2-aud";
const OWNER_EMAIL = "owner@example.com";
const OWNER_SUBJECT = "access_sub_owner_calendar_v2";

describe("calendarV2 on /api/admin/me", () => {
  let db: SqliteD1Database;
  let fixture: AccessJwtFixture;

  beforeEach(() => {
    db = createMigratedSqliteD1();
    insertAdminUser(db, { id: "admin_owner_calendar_v2", email: OWNER_EMAIL, accessSubject: OWNER_SUBJECT });
    fixture = createAccessJwtFixture({
      issuer: TEAM_DOMAIN,
      audience: ACCESS_AUD,
      keyId: "calendar-v2-key-1",
      signingKey: createAccessSigningKey("calendar-v2-key-1"),
      claims: { email: OWNER_EMAIL, sub: OWNER_SUBJECT },
    });
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, fixture.jwk));
  });

  afterEach(() => {
    db.sqlite.close();
    vi.unstubAllGlobals();
  });

  it.each([
    ["staging", "true", true],
    ["staging", "false", false],
    ["staging", undefined, false],
    ["staging", "TRUE", false],
    ["production", "true", false],
    ["production", undefined, false],
    [undefined, "true", false],
  ])("ENVIRONMENT=%s with ADMIN_CALENDAR_V2_ENABLED=%s answers %s", async (environment, value, expected) => {
    const response = await createApp().request(
      "/api/admin/me",
      { headers: { "Cf-Access-Jwt-Assertion": fixture.token } },
      { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD, DB: db, ENVIRONMENT: environment, ADMIN_CALENDAR_V2_ENABLED: value }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, calendarV2: expected });
  });

  it.each([
    ["true", true],
    [undefined, false],
  ])("local development (ADMIN_CALENDAR_V2_ENABLED=%s) answers %s", async (value, expected) => {
    const response = await createApp().request("/api/admin/me", {}, { ENVIRONMENT: "local", DB: db, ADMIN_CALENDAR_V2_ENABLED: value });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, calendarV2: expected });
  });
});
