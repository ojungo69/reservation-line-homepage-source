import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { createAccessJwksFetchMock, createAccessJwtFixture as createAccessJwtFixtureHelper, insertAdminUser as insertAdminUserHelper, type AdminRole } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-access-aud";
const OWNER_EMAIL = "owner@example.com";
const STAFF_EMAIL = "staff@example.com";
const OWNER_SUBJECT = "owner-subject-1";
const STAFF_SUBJECT = "staff-subject-1";
const KEY_ID = "test-access-key-1";

const createAccessJwtFixture = (claimOverrides: Record<string, unknown> = {}) =>
  createAccessJwtFixtureHelper({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: KEY_ID,
    claims: { email: OWNER_EMAIL, sub: OWNER_SUBJECT, ...claimOverrides }
  });

const createFetchMock = (jwk: ReturnType<typeof createAccessJwtFixture>["jwk"]) =>
  createAccessJwksFetchMock(TEAM_DOMAIN, jwk);

const baseEnv = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db
});

const insertAdminUser = (
  db: SqliteD1Database,
  id: string,
  email: string,
  subject: string,
  role: AdminRole
) =>
  insertAdminUserHelper(db, {
    id,
    email,
    accessSubject: subject,
    role,
    updatedAt: "2026-05-09T00:00:00.000Z",
  });

const post = async (
  db: SqliteD1Database,
  jwt: string,
  body: unknown
) => {
  const app = createApp();
  return app.request(
    "/api/admin/recurring/preview",
    {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": jwt,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    },
    baseEnv(db)
  );
};

describe("POST /api/admin/recurring/preview (Tier D.4 follow-up)", () => {
  let db: SqliteD1Database;

  // Pin system time so the max(dtstart, now) anchor is deterministic.
  // 2026-05-20T00:00:00Z — all existing tests use dtstart >= this date
  // so the anchor stays at dtstart and existing assertions hold.
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T00:00:00.000Z"));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    db?.sqlite.close();
  });

  it("expands a DAILY RRULE for 7 days and returns ISO occurrence list", async () => {
    db = createMigratedSqliteD1();
    insertAdminUser(db, "admin_owner_1", OWNER_EMAIL, OWNER_SUBJECT, "owner");
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    const response = await post(db, access.token, {
      rrule: "FREQ=DAILY",
      dtstart: "2026-05-19T10:00:00.000Z",
      windowEnd: "2026-05-25T10:00:00.000Z"
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.occurrences).toHaveLength(7);
    expect(body.occurrences[0]).toBe("2026-05-19T10:00:00.000Z");
    expect(body.occurrences[6]).toBe("2026-05-25T10:00:00.000Z");
  });

  it("expands BYDAY on the JST calendar day, not the UTC one", async () => {
    // 2026-08-09T22:00Z is Monday 07:00 JST but Sunday in UTC. Guards the route
    // actually passing localOffsetMs — without it BYDAY=MO lands on Tuesdays.
    db = createMigratedSqliteD1();
    insertAdminUser(db, "admin_owner_1", OWNER_EMAIL, OWNER_SUBJECT, "owner");
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    const response = await post(db, access.token, {
      rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=3",
      dtstart: "2026-08-09T22:00:00.000Z",
      windowEnd: "2026-09-10T00:00:00.000Z"
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.occurrences).toEqual([
      "2026-08-09T22:00:00.000Z",
      "2026-08-16T22:00:00.000Z",
      "2026-08-23T22:00:00.000Z"
    ]);
  });

  it("clamps window to 90 days from max(dtstart, now) and sets windowCapped=true", async () => {
    db = createMigratedSqliteD1();
    insertAdminUser(db, "admin_owner_1", OWNER_EMAIL, OWNER_SUBJECT, "owner");
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    // Request a 1-year window; server caps at max(dtstart, now) + 90d.
    // dtstart=2026-05-19 < now=2026-05-20 → anchor is now=2026-05-20,
    // cap = 2026-08-18. DAILY from 2026-05-19 through 2026-08-18 = 92.
    const response = await post(db, access.token, {
      rrule: "FREQ=DAILY",
      dtstart: "2026-05-19T00:00:00.000Z",
      windowEnd: "2027-05-19T00:00:00.000Z"
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.windowCapped).toBe(true);
    // 92 occurrences = day 0 (2026-05-19) through day 91 (2026-08-18).
    expect(body.occurrences).toHaveLength(92);
  });

  it("returns 400 invalid_request when rrule is malformed", async () => {
    db = createMigratedSqliteD1();
    insertAdminUser(db, "admin_owner_1", OWNER_EMAIL, OWNER_SUBJECT, "owner");
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    const response = await post(db, access.token, {
      rrule: "NOT A VALID RULE",
      dtstart: "2026-05-19T10:00:00.000Z",
      windowEnd: "2026-05-25T10:00:00.000Z"
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("invalid_rrule");
  });

  it.each([
    {
      caseName: "non-ISO dtstart (Date.parse-friendly but not canonical)",
      payload: {
        rrule: "FREQ=DAILY",
        dtstart: "2026/05/19 10:00:00",
        windowEnd: "2026-05-25T10:00:00.000Z"
      }
    },
    {
      caseName: "impossible calendar date (Feb 30)",
      payload: {
        rrule: "FREQ=DAILY",
        dtstart: "2026-02-30T10:00:00.000Z",
        windowEnd: "2026-03-05T10:00:00.000Z"
      }
    },
    {
      caseName: "malformed or invalid windowEnd",
      payload: {
        rrule: "FREQ=DAILY",
        dtstart: "2026-05-19T10:00:00.000Z",
        windowEnd: "NOT A VALID DATE"
      }
    }
  ])("returns 400 invalid_request for $caseName", async ({ payload }) => {
    db = createMigratedSqliteD1();
    insertAdminUser(db, "admin_owner_1", OWNER_EMAIL, OWNER_SUBJECT, "owner");
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    const response = await post(db, access.token, payload);
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.reason).toBe("invalid_request");
  });

  it("returns 400 invalid_request when dtstart is missing", async () => {
    db = createMigratedSqliteD1();
    insertAdminUser(db, "admin_owner_1", OWNER_EMAIL, OWNER_SUBJECT, "owner");
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    const response = await post(db, access.token, {
      rrule: "FREQ=DAILY",
      windowEnd: "2026-05-25T10:00:00.000Z"
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.reason).toBe("invalid_request");
  });

  it("returns 403 forbidden for staff role", async () => {
    db = createMigratedSqliteD1();
    insertAdminUser(db, "admin_staff_1", STAFF_EMAIL, STAFF_SUBJECT, "staff");
    const access = createAccessJwtFixture({ email: STAFF_EMAIL, sub: STAFF_SUBJECT });
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    const response = await post(db, access.token, {
      rrule: "FREQ=DAILY",
      dtstart: "2026-05-19T10:00:00.000Z",
      windowEnd: "2026-05-25T10:00:00.000Z"
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as any;
    expect(body.reason).toBe("forbidden");
  });

  it("accepts 1-2 digit fractional seconds (ISO 8601: .1 = 100ms, .12 = 120ms)", async () => {
    db = createMigratedSqliteD1();
    insertAdminUser(db, "admin_owner_1", OWNER_EMAIL, OWNER_SUBJECT, "owner");
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    // ISO 8601 fractional seconds: .1 means 0.1s = 100ms, .12 means 120ms.
    // The shared parser right-pads to 3 digits before conversion.
    // Verify both acceptance (200) and canonical ms in the first occurrence.
    const response1 = await post(db, access.token, {
      rrule: "FREQ=DAILY",
      dtstart: "2026-05-19T10:00:00.1Z",
      windowEnd: "2026-05-25T10:00:00.000Z"
    });
    expect(response1.status).toBe(200);
    const body1 = (await response1.json()) as { ok: boolean; occurrences: string[] };
    expect(body1.ok).toBe(true);
    // .1Z = 100ms → canonicalized to .100Z by Date.toISOString()
    expect(body1.occurrences[0]).toBe("2026-05-19T10:00:00.100Z");
    const response2 = await post(db, access.token, {
      rrule: "FREQ=DAILY",
      dtstart: "2026-05-19T10:00:00.12Z",
      windowEnd: "2026-05-25T10:00:00.000Z"
    });
    expect(response2.status).toBe(200);
    const body2 = (await response2.json()) as { ok: boolean; occurrences: string[] };
    expect(body2.ok).toBe(true);
    // .12Z = 120ms → canonicalized to .120Z by Date.toISOString()
    expect(body2.occurrences[0]).toBe("2026-05-19T10:00:00.120Z");
  });

  it("under-cap path returns truncatedByCap=false (200-occurrence cap covered by expander tests)", async () => {
    db = createMigratedSqliteD1();
    insertAdminUser(db, "admin_owner_1", OWNER_EMAIL, OWNER_SUBJECT, "owner");
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    // 90 days × every minute would blow past 200; even hourly does. Use
    // a 90-day window with daily expansion = 91 occurrences (under cap)
    // but check truncatedByCap=false. The hard cap is verified by the
    // expander tests; the endpoint just passes it through.
    // dtstart=2026-05-19 < now=2026-05-20 → anchor is now, cap = 2026-08-18.
    // Window end 2026-08-17 < cap → no capping. DAILY from 05-19 to 08-17 = 91.
    const response = await post(db, access.token, {
      rrule: "FREQ=DAILY",
      dtstart: "2026-05-19T10:00:00.000Z",
      windowEnd: "2026-08-17T10:00:00.000Z"
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.truncatedByCap).toBe(false);
    expect(body.occurrences).toHaveLength(91);
  });

  it("parity: old-DTSTART RRULE POST result matches SSR form expansion logic", async () => {
    // Regression guard for PR #85 codex advisory: the POST endpoint and
    // SSR form must produce identical occurrences for the same inputs.
    // The SSR form uses: windowAnchorMs = max(dtMs, nowMs);
    //                    cappedEnd = min(weMs, windowAnchorMs + 90d);
    // The POST endpoint must mirror this.
    db = createMigratedSqliteD1();
    insertAdminUser(db, "admin_owner_1", OWNER_EMAIL, OWNER_SUBJECT, "owner");
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    // Use an old DTSTART (before pinned now=2026-05-20) with a wide window
    // so the max(dtstart, now) anchor difference is observable.
    const rrule = "FREQ=WEEKLY;BYDAY=MO,WE,FR";
    const dtstart = "2026-01-01T09:00:00.000Z"; // far in the past
    const windowEnd = "2027-06-01T00:00:00.000Z"; // far in the future

    const response = await post(db, access.token, { rrule, dtstart, windowEnd });
    expect(response.status).toBe(200);
    const endpointBody = (await response.json()) as {
      ok: boolean;
      occurrences: string[];
      truncatedByWindow: boolean;
      truncatedByCap: boolean;
      windowCapped: boolean;
    };
    expect(endpointBody.ok).toBe(true);

    // Replicate the SSR form formula (src/app.ts lines 3066-3087)
    const { expandRrule } = await import("../src/google/rrule-expander");
    const RRULE_PREVIEW_MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
    const dtMs = new Date(dtstart).getTime();
    const weMs = new Date(windowEnd).getTime();
    const nowMsLocal = Date.now(); // pinned to 2026-05-20T00:00:00Z
    const windowAnchorMs = Math.max(dtMs, nowMsLocal);
    const cappedEnd = Math.min(weMs, windowAnchorMs + RRULE_PREVIEW_MAX_WINDOW_MS);
    const ssrExpansion = expandRrule({
      rrule,
      dtstartMs: dtMs,
      windowEndMs: cappedEnd,
      maxOccurrences: 200
    });
    expect(ssrExpansion.ok).toBe(true);
    if (!ssrExpansion.ok) return; // type narrowing

    const ssrOccurrences = ssrExpansion.occurrences.map((d) => d.toISOString());
    const ssrWindowCapped = cappedEnd < weMs;

    // Assert full parity between POST endpoint and SSR form
    expect(endpointBody.occurrences).toEqual(ssrOccurrences);
    expect(endpointBody.truncatedByWindow).toBe(ssrExpansion.truncatedByWindow);
    expect(endpointBody.truncatedByCap).toBe(ssrExpansion.truncatedByCap);
    expect(endpointBody.windowCapped).toBe(ssrWindowCapped);

    // Sanity: the anchor must be now (not dtstart) since dtstart < now
    expect(windowAnchorMs).toBe(nowMsLocal);
    expect(windowAnchorMs).toBeGreaterThan(dtMs);
  });
});
