import { describe, expect, it } from "vitest";

// T022 walk-manifest consistency (specs/002-monotone-glass quickstart §2): a
// fixture state that no STATE_WALK entry visits is silently untested — the
// exact fail-open the 2026-08-02 review caught (availability-loading existed
// in the fixture but was missing from the manifest, and availability
// error/empty never fired the API without a menu pick). This pins the
// fixture ↔ manifest coverage both ways and validates the action sources so
// the browser walk cannot rot into walking a subset.
import { buildApiStates } from "../scripts/browser-verification/fixtures/api-states.mjs";
import { ACTIONS, STATE_WALK } from "../scripts/browser-verification/state-walk.mjs";

describe("browser-verification state walk manifest", () => {
  const states = buildApiStates(Date.parse("2026-06-01T00:00:00.000Z"));

  it("rejects invalid availability dates without crashing the preview server", () => {
    for (const date of ["invalid", "2026-02-30", "2026-06-01T00:00:00Z"]) {
      const invalid = buildApiStates(Date.parse("2026-06-01T00:00:00.000Z"), { date });
      for (const state of ["form-default", "availability-empty"]) {
        expect(invalid[state].routes.availability).toEqual({
          status: 400, body: { ok: false, reason: "invalid_request" }
        });
      }
    }
  });

  it("rejects unknown or cross-store booking IDs instead of inventing available slots", () => {
    const query = { storeId: "store-1", resourceId: "r1", serviceIds: "svc-001", date: "2026-06-01" };
    for (const change of [
      { storeId: "missing" }, { resourceId: "missing" }, { serviceIds: "missing" },
      { serviceIds: "svc-001,missing" }, { resourceId: "r2" }, { serviceIds: "b-1" }
    ]) {
      const invalid = buildApiStates(Date.parse("2026-06-01T00:00:00.000Z"), { ...query, ...change });
      for (const state of ["form-default", "availability-empty"]) {
        expect(invalid[state].routes.availability).toEqual({
          status: 404, body: { ok: false, reason: "not_found" }
        });
      }
    }
  });

  it("enforces the inclusive booking window on the Tokyo calendar day", () => {
    const now = Date.parse("2026-06-01T15:00:00.000Z"); // June 2 in Tokyo.
    for (const date of ["2026-06-01", "2026-07-03"]) {
      const states = buildApiStates(now, { date });
      expect(states["form-default"].routes.availability).toEqual({
        status: 400, body: { ok: false, reason: "invalid_request" }
      });
    }
    for (const date of ["2026-06-02", "2026-07-02"]) {
      expect(buildApiStates(now, { date })["form-default"].routes.availability.body).toMatchObject({ ok: true, date });
    }
  });

  it("uses reservation occupancy including one cleanup interval and the treatment cap", () => {
    const now = Date.parse("2026-06-01T00:00:00.000Z");
    const single = buildApiStates(now, { serviceIds: "svc-001" })["form-default"].routes.availability.body;
    expect(single).toMatchObject({ durationMinutes: 35, slots: [{ startAt: "2026-06-01T01:00:00.000Z", endAt: "2026-06-01T01:35:00.000Z" }, {}, {}, {}] });
    const multiple = buildApiStates(now, { serviceIds: "svc-001,svc-002" })["form-default"].routes.availability.body;
    expect(multiple).toMatchObject({ durationMinutes: 80, slots: [{ startAt: "2026-06-01T01:00:00.000Z", endAt: "2026-06-01T02:20:00.000Z" }, {}, {}, {}] });
    expect(buildApiStates(now, { serviceIds: "svc-001,svc-002,svc-003,svc-004,svc-005" })["form-default"].routes.availability).toEqual({
      status: 400, body: { ok: false, reason: "duration_limit_exceeded" }
    });
  });

  it("visits every fixture state (fixture → manifest)", () => {
    const visited = new Set(
      STATE_WALK.map((entry) => new URL(entry.url, "http://x").searchParams.get("state")).filter(Boolean)
    );
    expect([...Object.keys(states)].filter((name) => !visited.has(name))).toEqual([]);
  });

  it("references only existing fixture states (manifest → fixture)", () => {
    for (const entry of STATE_WALK) {
      const state = new URL(entry.url, "http://x").searchParams.get("state");
      if (state !== null) {
        expect(Object.keys(states), `${entry.state}: unknown state "${state}"`).toContain(state);
      }
    }
  });

  it("uses only defined, syntactically valid action sources", () => {
    for (const entry of STATE_WALK) {
      if (!entry.actionsSource) continue;
      const source = ACTIONS[entry.actionsSource];
      expect(source, `${entry.state}: unknown action "${entry.actionsSource}"`).toBeTypeOf("string");
      // Evaluating the source must yield a function — this is exactly how the
      // runner invokes it (`(${source})()`).
      expect(new Function(`return (${source})`)(), `${entry.state}: action does not parse`).toBeTypeOf("function");
      // An action without an `after` readiness condition proves nothing.
      expect(entry.after, `${entry.state}: actionsSource without after`).toBeDefined();
    }
  });

  it("gives every entry a unique name and a readiness selector", () => {
    const names = STATE_WALK.map((entry) => entry.state);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of STATE_WALK) {
      expect(entry.ready?.selector, `${entry.state}: missing ready.selector`).toBeTypeOf("string");
    }
  });

  it("pins post-response readiness for options error/empty (no fail-open ready)", () => {
    // A bare always-present selector (#status) passes ~20ms after load and the
    // scan photographs the INITIAL view — ready must only resolve once the
    // /options response has been applied (2026-08-02 fresh-review finding).
    const byName = Object.fromEntries(STATE_WALK.map((entry) => [entry.state, entry]));
    expect(byName["options-error"]?.ready).toEqual({
      selector: "#status",
      text: "予約画面を初期化できませんでした"
    });
    expect(byName["options-empty"]?.ready).toEqual({
      selector: "#store:disabled option",
      text: "選択できる店舗がありません"
    });
  });

  it("keeps the FR-004/FR-012 sub-states in the walk", () => {
    const names = new Set(STATE_WALK.map((entry) => entry.state));
    for (const required of [
      "form-default/slots-visible",
      "form-default/picker-selected",
      "form-default/slot-selected",
      "form-default/slot-disabled",
      "form-default/consent-ready"
    ]) {
      expect(names, required).toContain(required);
    }
  });

  it("keeps loading states unresolvable and error states 5xx (fixture shape)", () => {
    for (const [name, state] of Object.entries(states)) {
      for (const [route, response] of Object.entries(state.routes)) {
        if (name.includes("loading") && route === (name.startsWith("my-") ? "myReservations" : name.split("-")[0])) {
          expect(response.delayMs, `${name}.${route}: loading state must delay`).toBeGreaterThan(0);
        }
      }
      if (name.endsWith("-error")) {
        const route = name.startsWith("my-") ? "myReservations" : name.split("-")[0];
        expect(state.routes[route]?.status, `${name}: error state must be 5xx`).toBeGreaterThanOrEqual(500);
      }
    }
  });
});
