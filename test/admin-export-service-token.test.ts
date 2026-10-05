import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { createAccessJwtFixture, createAccessJwksFetchMock } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// PR #3b: regression tests pinning that
// /api/admin/reservations/export.csv accepts Cloudflare Access Service Token
// JWTs in staging (when fully gated), but the human-only /search endpoint
// continues to reject them, AND production never grants access via the Service
// Token path regardless of env or admin_users state.

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-access-aud";
const SERVICE_TOKEN_CLIENT_ID = "smoke-runner.access";
const SERVICE_TOKEN_EMAIL = `service-token+${SERVICE_TOKEN_CLIENT_ID}@internal.invalid`;
const KEY_ID = "test-access-key-1";

const serviceTokenJwtFixture = () =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: KEY_ID,
    claims: { email: "", sub: "", common_name: SERVICE_TOKEN_CLIENT_ID }
  });

const insertServiceTokenAdmin = (
  db: SqliteD1Database,
  role: "system_admin" | "owner" | "staff" = "system_admin"
) => {
  db.sqlite
    .prepare(
      `INSERT INTO admin_users (id, email, access_subject, role, active, is_service_token, updated_at)
       VALUES (?, ?, ?, ?, 1, 1, '2026-05-16T00:00:00.000Z')`
    )
    .run("admin_svc_smoke", SERVICE_TOKEN_EMAIL, SERVICE_TOKEN_CLIENT_ID, role);
};

const insertCustomer = (db: SqliteD1Database, id: string) => {
  db.sqlite
    .prepare(
      `INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, phone_hash, block_status, updated_at)
       VALUES (?, ?, NULL, NULL, NULL, 'active', '2026-05-16T00:00:00.000Z')`
    )
    .run(id, `cust ${id}`);
};

const insertReservation = (
  db: SqliteD1Database,
  args: { id: string; customerId: string; startAt: string; endAt: string }
) => {
  db.sqlite
    .prepare(
      `INSERT INTO reservations (
         id, store_id, service_id, customer_id, resource_id, line_identity_id,
         source, status, start_at, end_at, duration_minutes, pending_expires_at,
         created_by, updated_by, idempotency_key, google_sync_state, version, updated_at
       ) VALUES (
         ?, 'kyoto', 'service_kyoto_default_60', ?, 'resource_kyoto_calendar', NULL,
         'phone_admin', 'confirmed', ?, ?, 60, NULL,
         'test', 'test', ?, 'not_required', 1, '2026-05-16T00:00:00.000Z'
       )`
    )
    .run(args.id, args.customerId, args.startAt, args.endAt, `idem_${args.id}`);
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

const fetchWithServiceToken = (
  db: SqliteD1Database,
  url: string,
  token: string,
  envOverrides: EnvOverrides = {}
) => {
  const app = createApp();
  return app.request(
    url,
    { headers: { "Cf-Access-Jwt-Assertion": token, Accept: "text/csv" } },
    baseEnv(db, envOverrides)
  );
};

describe("GET /api/admin/reservations/export.csv (Service Token)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts a staging Service Token JWT when fully gated and returns CSV", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertServiceTokenAdmin(db);
      insertCustomer(db, "cust_smoke_1");
      insertReservation(db, {
        id: "rsv_smoke_1",
        customerId: "cust_smoke_1",
        startAt: "2026-06-01T01:00:00.000Z",
        endAt: "2026-06-01T02:00:00.000Z"
      });
      const fixture = serviceTokenJwtFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, fixture.jwk));
      const response = await fetchWithServiceToken(
        db,
        "/api/admin/reservations/export.csv?from=2026-06-01&to=2026-06-30",
        fixture.token
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/csv");
      const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
        new Uint8Array(await response.arrayBuffer())
      );
      const lines = text.replace(/^﻿/, "").split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(2);
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects the Service Token when STAGING_SERVICE_TOKEN_AUTH is not 'true'", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertServiceTokenAdmin(db);
      const fixture = serviceTokenJwtFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, fixture.jwk));
      const response = await fetchWithServiceToken(
        db,
        "/api/admin/reservations/export.csv?from=2026-06-01&to=2026-06-30",
        fixture.token,
        { STAGING_SERVICE_TOKEN_AUTH: "" }
      );
      expect(response.status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects the Service Token in production even when admin_users row + flag agree", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertServiceTokenAdmin(db);
      const fixture = serviceTokenJwtFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, fixture.jwk));
      const response = await fetchWithServiceToken(
        db,
        "/api/admin/reservations/export.csv?from=2026-06-01&to=2026-06-30",
        fixture.token,
        { ENVIRONMENT: "production" }
      );
      expect(response.status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });

  it("denies a Service Token row with role 'staff' via the owner+ gate (403)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertServiceTokenAdmin(db, "staff");
      const fixture = serviceTokenJwtFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, fixture.jwk));
      const response = await fetchWithServiceToken(
        db,
        "/api/admin/reservations/export.csv?from=2026-06-01&to=2026-06-30",
        fixture.token
      );
      expect(response.status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });
});

describe("GET /api/admin/reservations/search (Service Token rejected by design)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a fully-gated Service Token because /search does not opt in", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertServiceTokenAdmin(db);
      const fixture = serviceTokenJwtFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, fixture.jwk));
      const response = await fetchWithServiceToken(
        db,
        "/api/admin/reservations/search?from=2026-06-01&to=2026-06-30",
        fixture.token
      );
      expect(response.status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });
});
