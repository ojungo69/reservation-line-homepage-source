import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { createAccessJwksFetchMock, createAccessJwtFixture, insertAdminUser } from "./helpers/admin-access";
import { createMigratedSqliteD1 } from "./helpers/sqlite-d1";

const issuer = "https://diagnostic.example.cloudflareaccess.com";
const audience = "staging-diagnostic-body";

afterEach(() => vi.unstubAllGlobals());

describe.each(["drift-sweep", "sentry-test"])("staging %s JSON boundary", (endpoint) => {
  it.each([{ body: null }, { body: [] }, { body: "text" }, { body: 1 }, { body: false }])(
    "rejects non-object JSON $body after authenticating the system admin",
    async ({ body }) => {
      const db = createMigratedSqliteD1();
      const access = createAccessJwtFixture({
        issuer, audience, keyId: "diagnostic-body-key",
        claims: { email: "diagnostic@example.test", sub: "diagnostic-body-sub" }
      });
      vi.stubGlobal("fetch", createAccessJwksFetchMock(issuer, access.jwk));
      try {
        insertAdminUser(db, {
          id: "diagnostic-body-admin", email: "diagnostic@example.test",
          accessSubject: "diagnostic-body-sub", role: "system_admin"
        });
        const response = await createApp().request(`/api/admin/staging/${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": access.token },
          body: JSON.stringify(body)
        }, { DB: db, ENVIRONMENT: "staging", ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: audience });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ ok: false, reason: "invalid_request" });
        expect(response.headers.get("Cache-Control")).toBe("no-store");
      } finally {
        db.sqlite.close();
      }
    }
  );
});
