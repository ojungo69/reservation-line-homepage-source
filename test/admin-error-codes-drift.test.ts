import { describe, expect, it } from "vitest";

import { isAdminApiFailureCode } from "../src/admin/admin-error-codes";
import { collectAdminFailureReasonCodes } from "./helpers/admin-failure-code-scan";

// Drift guard for the AdminApiFailureCode union (src/admin/admin-error-codes.ts).
// If a new `{ ok: false, reason: "<code>" }`, lone `{ reason: "<code>" }`, or
// `{ error: "<code>" }` failure code is introduced in the admin layers without
// being registered in the union, this test fails — keeping the single source of
// truth exhaustive.
describe("AdminApiFailureCode union drift guard", () => {
  it("registers every failure-code literal returned from the admin layers", () => {
    const hits = collectAdminFailureReasonCodes();
    const unregistered = hits.filter((hit) => !isAdminApiFailureCode(hit.code));

    const detail = unregistered
      .map((hit) => `  - "${hit.code}" at ${hit.location}`)
      .join("\n");
    expect(
      unregistered,
      unregistered.length === 0
        ? ""
        : `Found admin failure-code literal(s) missing from ADMIN_API_FAILURE_CODES ` +
            `(src/admin/admin-error-codes.ts). Either add them to the union, or — if a value ` +
            `is not an admin API failure code — stop returning it from a ` +
            `{ ok: false, reason } / { reason } / { error } shape in the admin layers:\n${detail}`
    ).toEqual([]);
  });

  it("finds codes in BOTH Result shapes (guards each branch against silently breaking)", () => {
    const hits = collectAdminFailureReasonCodes();
    const reasonCodes = new Set(hits.filter((h) => h.shape === "reason").map((h) => h.code));
    const errorCodes = new Set(hits.filter((h) => h.shape === "error").map((h) => h.code));
    // Per-shape floors catch one extraction branch silently breaking (e.g. the
    // `{ error }` shape regressing to zero) — a single combined floor would
    // still pass on the reason branch alone. The floors sit well below the
    // current per-shape counts, so ordinary code churn does not trip them.
    expect(reasonCodes.size).toBeGreaterThanOrEqual(25);
    expect(errorCodes.size).toBeGreaterThanOrEqual(12);
  });
});
