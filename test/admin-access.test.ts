import { describe, expect, it } from "vitest";

import { authenticateAdmin } from "../src/admin/access";
import { createAccessJwksFetchMock, createAccessJwtFixture } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// Cloudflare Access Service Token JWT shape, verified against Cloudflare docs on
// 2026-05-16 (Application token Authorization cookie reference):
//   - aud / iss / exp / nbf / iat / kid / sig: identical to human-IdP tokens.
//   - email: empty string.
//   - sub:   empty string.
//   - common_name: the Service Token Client ID (non-empty).
// If a future spec change moves the Client ID to a different claim, the
// classification logic in src/admin/access.ts and these fixtures must be
// updated together.

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-access-aud";
const HUMAN_EMAIL = "owner@example.com";
const HUMAN_ACCESS_SUBJECT = "human-access-subject-1";
const SERVICE_TOKEN_CLIENT_ID = "abc123.access";
const SERVICE_TOKEN_PLACEHOLDER_EMAIL = `service-token+${SERVICE_TOKEN_CLIENT_ID}@internal.invalid`;

const SIGNING_KEY_ID = "test-access-key-1";

const humanFixture = (overrides: Record<string, unknown> = {}) =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: SIGNING_KEY_ID,
    claims: { email: HUMAN_EMAIL, sub: HUMAN_ACCESS_SUBJECT, ...overrides }
  });

const serviceTokenFixture = (overrides: Record<string, unknown> = {}) =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: SIGNING_KEY_ID,
    claims: { email: "", sub: "", common_name: SERVICE_TOKEN_CLIENT_ID, ...overrides }
  });

const insertHumanAdmin = (
  db: SqliteD1Database,
  options: { id?: string; email?: string; accessSubject?: string; role?: string; isServiceToken?: 0 | 1 } = {}
) => {
  const id = options.id ?? "admin_human_1";
  const email = options.email ?? HUMAN_EMAIL;
  const accessSubject = options.accessSubject ?? HUMAN_ACCESS_SUBJECT;
  const role = options.role ?? "owner";
  const isServiceToken = options.isServiceToken ?? 0;
  db.sqlite
    .prepare(
      `
        INSERT INTO admin_users (id, email, access_subject, role, active, is_service_token, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, '2026-05-16T00:00:00.000Z')
      `
    )
    .run(id, email, accessSubject, role, isServiceToken);
};

const insertServiceTokenAdmin = (
  db: SqliteD1Database,
  options: { id?: string; clientId?: string; email?: string; role?: string } = {}
) => {
  const id = options.id ?? "admin_svc_1";
  const clientId = options.clientId ?? SERVICE_TOKEN_CLIENT_ID;
  const email = options.email ?? SERVICE_TOKEN_PLACEHOLDER_EMAIL;
  const role = options.role ?? "staff";
  db.sqlite
    .prepare(
      `
        INSERT INTO admin_users (id, email, access_subject, role, active, is_service_token, updated_at)
        VALUES (?, ?, ?, ?, 1, 1, '2026-05-16T00:00:00.000Z')
      `
    )
    .run(id, email, clientId, role);
};

type EnvOverrides = {
  ENVIRONMENT?: string;
  STAGING_SERVICE_TOKEN_AUTH?: string;
};

const baseEnv = (db: SqliteD1Database, overrides: EnvOverrides = {}): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  ENVIRONMENT: "staging",
  STAGING_SERVICE_TOKEN_AUTH: "true",
  DB: db,
  ...overrides
});

describe("authenticateAdmin: Service Token path", () => {
  it("authenticates a Service Token in staging when flag, opt-in, and admin_users row all line up", async () => {
    const db = createMigratedSqliteD1();
    insertServiceTokenAdmin(db);
    const { token, jwk } = serviceTokenFixture();

    const result = await authenticateAdmin(
      {
        token,
        env: baseEnv(db),
        fetcher: createAccessJwksFetchMock(TEAM_DOMAIN, jwk)
      },
      { allowServiceToken: true }
    );

    expect(result).toEqual({
      ok: true,
      admin: { id: "admin_svc_1", email: SERVICE_TOKEN_PLACEHOLDER_EMAIL, role: "staff", staff_member_id: null, store_id: null }
    });
  });

  it("returns admin_not_registered when no Service Token row matches the common_name", async () => {
    const db = createMigratedSqliteD1();
    insertServiceTokenAdmin(db, { clientId: "other-client.access" });
    const { token, jwk } = serviceTokenFixture();

    const result = await authenticateAdmin(
      {
        token,
        env: baseEnv(db),
        fetcher: createAccessJwksFetchMock(TEAM_DOMAIN, jwk)
      },
      { allowServiceToken: true }
    );

    expect(result).toEqual({ ok: false, reason: "admin_not_registered" });
  });

  it("rejects the Service Token when the caller route does not opt in (default)", async () => {
    const db = createMigratedSqliteD1();
    insertServiceTokenAdmin(db);
    const { token, jwk } = serviceTokenFixture();

    const result = await authenticateAdmin({
      token,
      env: baseEnv(db),
      fetcher: createAccessJwksFetchMock(TEAM_DOMAIN, jwk)
    });

    expect(result).toEqual({ ok: false, reason: "admin_auth_failed" });
  });

  it("rejects the Service Token when STAGING_SERVICE_TOKEN_AUTH is not 'true'", async () => {
    const db = createMigratedSqliteD1();
    insertServiceTokenAdmin(db);
    const { token, jwk } = serviceTokenFixture();

    const result = await authenticateAdmin(
      {
        token,
        env: baseEnv(db, { STAGING_SERVICE_TOKEN_AUTH: "" }),
        fetcher: createAccessJwksFetchMock(TEAM_DOMAIN, jwk)
      },
      { allowServiceToken: true }
    );

    expect(result).toEqual({ ok: false, reason: "admin_auth_failed" });
  });

  it("rejects the Service Token in production even with opt-in and the flag set", async () => {
    const db = createMigratedSqliteD1();
    insertServiceTokenAdmin(db);
    const { token, jwk } = serviceTokenFixture();

    const result = await authenticateAdmin(
      {
        token,
        env: baseEnv(db, { ENVIRONMENT: "production" }),
        fetcher: createAccessJwksFetchMock(TEAM_DOMAIN, jwk)
      },
      { allowServiceToken: true }
    );

    expect(result).toEqual({ ok: false, reason: "admin_auth_failed" });
  });

  it("does not let a human JWT match a Service Token row sharing the same access_subject", async () => {
    const db = createMigratedSqliteD1();
    insertServiceTokenAdmin(db, { clientId: HUMAN_ACCESS_SUBJECT, email: SERVICE_TOKEN_PLACEHOLDER_EMAIL });
    const { token, jwk } = humanFixture();

    const result = await authenticateAdmin({
      token,
      env: baseEnv(db),
      fetcher: createAccessJwksFetchMock(TEAM_DOMAIN, jwk)
    });

    expect(result).toEqual({ ok: false, reason: "admin_not_registered" });
  });

  it("rejects a human JWT carrying an injected common_name claim as a mixed/invalid principal", async () => {
    const db = createMigratedSqliteD1();
    insertHumanAdmin(db);
    insertServiceTokenAdmin(db);
    const { token, jwk } = humanFixture({ common_name: SERVICE_TOKEN_CLIENT_ID });

    const result = await authenticateAdmin(
      {
        token,
        env: baseEnv(db),
        fetcher: createAccessJwksFetchMock(TEAM_DOMAIN, jwk)
      },
      { allowServiceToken: true }
    );

    expect(result).toEqual({ ok: false, reason: "admin_auth_failed" });
  });
});

describe("authenticateAdmin: human path regression", () => {
  it("authenticates an existing human admin row", async () => {
    const db = createMigratedSqliteD1();
    insertHumanAdmin(db);
    const { token, jwk } = humanFixture();

    const result = await authenticateAdmin({
      token,
      env: baseEnv(db),
      fetcher: createAccessJwksFetchMock(TEAM_DOMAIN, jwk)
    });

    expect(result).toEqual({
      ok: true,
      admin: { id: "admin_human_1", email: HUMAN_EMAIL, role: "owner", staff_member_id: null, store_id: null }
    });
  });
});
