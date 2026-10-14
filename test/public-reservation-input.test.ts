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
  afterEach(() => vi.restoreAllMocks());

  it("rejects a submitted thirteenth menu before identity verification instead of dropping it", async () => {
    const body = validRequest();
    body.serviceIds = Array.from({ length: 13 }, (_, index) => `service-example-${index + 1}`);
    body.serviceId = body.serviceIds[0];
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

  it("rejects availability for 13 short menus and still accepts the complete 12-menu selection", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-09T23:00:00.000Z"));
      const ids = Array.from({ length: 13 }, (_, index) => `service-example-${index + 1}`);
      for (const id of ids) {
        d1.sqlite.prepare("INSERT INTO services (id, store_id, name, duration_minutes, active) VALUES (?, 'kyoto', '架空メニュー', 5, 1)").run(id);
      }
      const query = new URLSearchParams({ storeId: "kyoto", serviceId: ids[0], resourceId: "resource_kyoto_calendar", date: "2026-05-10", serviceIds: ids.join(",") });
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
