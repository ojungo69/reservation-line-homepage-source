import { describe, expect, it } from "vitest";
import { statusForAdminAddCustomerVisitResult } from "../src/routes/shared";

describe("statusForAdminAddCustomerVisitResult", () => {
  it("maps success to 201", () => {
    expect(statusForAdminAddCustomerVisitResult({ ok: true, visitId: "v1", replayed: false })).toBe(201);
  });
  it("maps a replay to 200", () => {
    expect(statusForAdminAddCustomerVisitResult({ ok: true, visitId: "v1", replayed: true })).toBe(200);
  });
  it("maps forbidden to 403", () => {
    expect(statusForAdminAddCustomerVisitResult({ ok: false, reason: "forbidden" })).toBe(403);
  });
  it("maps not_found to 404", () => {
    expect(statusForAdminAddCustomerVisitResult({ ok: false, reason: "not_found" })).toBe(404);
  });
  it("maps invalid_visit_date / future_visit_date / invalid_store / notes_too_long / invalid_request to 400", () => {
    for (const reason of ["invalid_visit_date", "future_visit_date", "invalid_store", "notes_too_long", "invalid_request"] as const) {
      expect(statusForAdminAddCustomerVisitResult({ ok: false, reason })).toBe(400);
    }
  });
  it("maps idempotency conflicts to 409", () => {
    expect(statusForAdminAddCustomerVisitResult({ ok: false, reason: "idempotency_conflict" })).toBe(409);
    expect(statusForAdminAddCustomerVisitResult({ ok: false, reason: "idempotency_in_progress" })).toBe(409);
  });
  it("maps write_failed to 500", () => {
    expect(statusForAdminAddCustomerVisitResult({ ok: false, reason: "write_failed" })).toBe(500);
  });
});
