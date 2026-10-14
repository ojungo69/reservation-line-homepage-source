import { afterEach, describe, expect, it, vi } from "vitest";

import { publicRoutes } from "../src/routes/public";
import { getStringArray } from "../src/routes/shared";
import { createMigratedSqliteD1 } from "./helpers/sqlite-d1";

const validRequest = () => ({
  idToken: "example-id-token", lineAccessToken: "example-access-token", turnstileToken: "example-security-token",
  idempotencyKey: "example-request", storeId: "example-store", serviceId: "example-service",
  serviceIds: ["example-service"], resourceId: "example-resource", startAt: "2026-06-01T01:00:00.000Z",
  customer: { displayName: "架空 太郎", phone: "09012345678" },
  consents: { noticeVersion: "1", cancellationPolicyVersion: "1", privacyPolicyVersion: "1" }
});

describe("U7: public menu selection boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    { label: "usable IDs only", invalidItems: [] },
    { label: "mixed invalid items", invalidItems: [null, " ", "x".repeat(129)] }
  ])("rejects a submitted thirteenth menu with $label before identity verification", async ({ invalidItems }) => {
    const ids = Array.from({ length: 13 }, (_, index) => `service-example-${index + 1}`);
    const body = { ...validRequest(), serviceId: ids[0], serviceIds: [...invalidItems, ...ids, ids[0]] };
    const response = await publicRoutes.request("/reservations", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    }, {});
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, reason: "invalid_request" });
  });

  it("rejects an over-limit string array and keeps trim/deduplication at the boundary", () => {
    const ids = Array.from({ length: 13 }, (_, index) => `service-example-${index + 1}`);
    expect(getStringArray({ serviceIds: ids }, "serviceIds", 12, 128)).toBeUndefined();
    expect(getStringArray({ serviceIds: [" s1 ", "s1", "s2"] }, "serviceIds", 12, 128)).toEqual(["s1", "s2"]);
  });

  // An explicit but unusable menu list is rejected instead of silently booking the singular
  // serviceId: that would change the menus the customer chose. Only an absent list (or an
  // empty query value) keeps the legacy single-menu fallback.
  it.each([",", "  ,  ", "x".repeat(129)])("rejects unusable availability serviceIds %j", async serviceIds => {
    const query = new URLSearchParams({
      storeId: "kyoto", serviceId: "service_kyoto_default_60", serviceIds,
      resourceId: "resource_kyoto_calendar", date: "2026-05-10"
    });
    const response = await publicRoutes.request(`/availability?${query}`, {}, {});
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, reason: "invalid_request" });
  });

  it("keeps the legacy serviceId for an empty availability serviceIds value", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-09T23:00:00.000Z"));
      const query = new URLSearchParams({
        storeId: "kyoto", serviceId: "service_kyoto_default_60", serviceIds: "",
        resourceId: "resource_kyoto_calendar", date: "2026-05-10"
      });
      const env = { DB: d1 as unknown as D1Database, GOOGLE_LIVE_AVAILABILITY_ENABLED: "false" };
      const response = await publicRoutes.request(`/availability?${query}`, {}, env);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true, serviceId: "service_kyoto_default_60", serviceIds: ["service_kyoto_default_60"], durationMinutes: 65
      });
    } finally {
      d1.sqlite.close();
    }
  });

  it.each([
    { label: "an empty array", serviceIds: [] },
    { label: "null", serviceIds: null },
    { label: "only unusable strings", serviceIds: ["", "  ", "x".repeat(129)] },
    { label: "a non-string item", serviceIds: [null] },
    { label: "a usable ID next to a non-string item", serviceIds: ["example-unused-service", null] }
  ])("rejects submitted serviceIds with $label instead of booking the legacy serviceId", async ({ serviceIds }) => {
    const body = { ...validRequest(), serviceId: "service_kyoto_default_60", serviceIds };
    const response = await publicRoutes.request("/reservations", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    }, {});
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, reason: "invalid_request" });
  });

  it("books the legacy serviceId when serviceIds is absent", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-09T00:00:00.000Z"), toFake: ["Date"] });
    const d1 = createMigratedSqliteD1();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true }))
      .mockResolvedValueOnce(Response.json({
        sub: "example-line-user", aud: "example-line-channel", exp: 1_800_000_000, iat: 1_700_000_000
      }))
      .mockResolvedValueOnce(Response.json({ userId: "example-line-user" }))
      .mockResolvedValueOnce(Response.json({ friendFlag: true }))
    );
    // JSON.stringify drops the undefined serviceIds, so the request has no list at all.
    const withoutList = {
      ...validRequest(), storeId: "kyoto", serviceId: "service_kyoto_default_60", serviceIds: undefined,
      resourceId: "resource_kyoto_calendar",
      consents: {
        noticeVersion: "notice-terms-2026-06", cancellationPolicyVersion: "cancel-2026-08-31", privacyPolicyVersion: "privacy-2026-06"
      }
    };
    const env = {
      DB: d1 as unknown as D1Database, LINE_CHANNEL_ID: "example-line-channel", TURNSTILE_SECRET_KEY: "example-secret"
    };
    try {
      const response = await publicRoutes.request("/reservations", {
        method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.10" }, body: JSON.stringify(withoutList)
      }, env);
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        ok: true, storeId: "kyoto", status: "pending_approval", startAt: "2026-06-01T01:00:00.000Z", endAt: "2026-06-01T02:05:00.000Z"
      });
    } finally {
      d1.sqlite.close();
    }
  });

  it.each([
    { label: "usable IDs only", invalidItems: [] },
    { label: "mixed invalid items", invalidItems: [" ", "x".repeat(129)] }
  ])("rejects availability for 13 short menus with $label and accepts all 12", async ({ invalidItems }) => {
    const d1 = createMigratedSqliteD1();
    try {
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-09T23:00:00.000Z"));
      const ids = Array.from({ length: 13 }, (_, index) => `service-example-${index + 1}`);
      for (const id of ids) {
        d1.sqlite.prepare("INSERT INTO services (id, store_id, name, duration_minutes, active) VALUES (?, 'kyoto', '架空メニュー', 5, 1)").run(id);
      }
      const query = new URLSearchParams({ storeId: "kyoto", serviceId: ids[0], resourceId: "resource_kyoto_calendar", date: "2026-05-10", serviceIds: [...invalidItems, ...ids].join(",") });
      const env = { DB: d1 as unknown as D1Database, GOOGLE_LIVE_AVAILABILITY_ENABLED: "false" };
      const rejected = await publicRoutes.request(`/availability?${query}`, {}, env);
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({ ok: false, reason: "invalid_request" });
      query.set("serviceIds", [...ids.slice(0, 12), ` ${ids[0]} `].join(","));
      const accepted = await publicRoutes.request(`/availability?${query}`, {}, env);
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({ ok: true, serviceIds: ids.slice(0, 12), durationMinutes: 65 });
    } finally {
      d1.sqlite.close();
    }
  });
});

describe("U5: public reservation parse errors", () => {
  it.each(["malformed JSON", "empty customer name"])("returns a usable failure reason for %s", async invalid => {
    const body = validRequest();
    body.customer.displayName = "";
    const response = await publicRoutes.request("/reservations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: invalid === "malformed JSON" ? "{" : JSON.stringify(body)
    }, {});
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, reason: "invalid_request" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
