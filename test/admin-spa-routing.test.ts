import { describe, expect, it } from "vitest";

import { shouldRouteToWorker } from "../src/index";

describe("shouldRouteToWorker — admin canonical /admin routing", () => {
  it("routes the canonical /admin SPA namespace to the worker", () => {
    for (const p of ["/admin", "/admin/", "/admin/reservations", "/admin/settings/x/y", "/admin/staff"]) {
      expect(shouldRouteToWorker(p)).toBe(true);
    }
  });

  it("does NOT route /admin-next through this predicate (404'd at the entrypoint first)", () => {
    // /admin-next was retired in Phase 5: handleFetch 404s it before this
    // predicate runs, so /admin-next must NOT be treated as a worker-routed path
    // here (and must not match the /admin/ prefix).
    for (const p of ["/admin-next", "/admin-next/", "/admin-next/reservations"]) {
      expect(shouldRouteToWorker(p)).toBe(false);
    }
  });

  it("routes /api/* to the worker", () => {
    expect(shouldRouteToWorker("/api/admin/reservations")).toBe(true);
    expect(shouldRouteToWorker("/api/health")).toBe(true);
  });

  it("does NOT route hashed admin assets to the worker (ASSETS binding serves them)", () => {
    expect(shouldRouteToWorker("/admin-app/index.html")).toBe(false);
    expect(shouldRouteToWorker("/admin-app/assets/vendor-DEfWVLot.js")).toBe(false);
  });

  it("does NOT match look-alike prefixes (exact-shape predicate, not bare startsWith)", () => {
    for (const p of ["/admin-other", "/administrator", "/admin-app", "/adminx"]) {
      expect(shouldRouteToWorker(p)).toBe(false);
    }
  });

  it("does NOT route public surfaces to the worker", () => {
    expect(shouldRouteToWorker("/")).toBe(false);
    expect(shouldRouteToWorker("/customer/reservations-options")).toBe(false);
  });
});
