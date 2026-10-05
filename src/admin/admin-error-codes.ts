/**
 * Admin API failure code universe — single source of truth.
 *
 * Spans the three layers that admin endpoints return failure codes from:
 *   - `src/admin/**\/*.ts` (handler / type-alias literal members)
 *   - `src/routes/admin-api.ts` (direct admin API response codes)
 *   - `src/routes/shared.ts`  (admin gate / period filter parse)
 *
 * Adoption workflow when introducing a new failure code:
 *   1. Add the code to the relevant backend handler / type union.
 *   2. Add the code to this list so the union stays exhaustive.
 *   3. If user-visible, add a display string to
 *      `admin-app/src/lib/error-messages.ts`.
 *
 * Handlers can opt in to compile-time enforcement two ways:
 *   - on the returned reason expression, e.g.
 *     `return { ok: false, reason: "forbidden" satisfies AdminApiFailureCode };`
 *   - on the failure-union type alias by constraining via `Extract`, e.g.
 *     `export type FooError = Extract<AdminApiFailureCode, "forbidden" | "not_found">;`
 *
 * `satisfies` cannot be applied to a type alias, so the older pattern
 * `type FooError = ... satisfies AdminApiFailureCode` is a type error.
 * Likewise, declaring `type FooError = (...) | AdminApiFailureCode` does
 * the opposite of enforcement — it widens FooError to accept every
 * registered code — and must NOT be used as the adoption pattern. Both
 * opt-in forms above are intentionally NOT applied in this PR — it's
 * left as a separate follow-up so the change here is purely additive.
 *
 * A drift guard (`test/admin-error-codes-drift.test.ts`, via
 * `test/helpers/admin-failure-code-scan.ts`) mechanically validates this list
 * against the source with a TypeScript-AST scan. It covers the two reliably
 * detectable Result shapes — `{ ok: false, reason: "<code>" }` and
 * `{ error: "<code>" }` — across the three layers above, asserting every
 * snake_case literal is registered here. Codes that appear only inside inline
 * type aliases (e.g. `| "outside_business_hours"`) or as bare string returns
 * are out of that scan's scope and stay covered by this manual workflow plus
 * the optional compile-time `satisfies` / `Extract` enforcement above.
 */
export const ADMIN_API_FAILURE_CODES = [
  // -- src/admin/**\/*.ts (handler / type-alias literal members) --
  "admin_auth_failed",
  "admin_not_registered",
  "already_linked",
  "already_merged",
  "already_resolved",
  "checked_in_locked",
  "customer_blocked",
  "customer_gate_required",
  "customer_not_found",
  "customer_time_conflict",
  "email_in_use",
  "forbidden",
  "forbidden_role_escalation",
  "forbidden_self_deactivation",
  "friend_not_fetched",
  "friend_not_found",
  "gate_email_failed",
  "future_visit_date",
  "has_future_reservations",
  "idempotency_conflict",
  "idempotency_in_progress",
  "immutable_source",
  "immutable_store",
  "invalid_conflict_type",
  "invalid_date",
  "invalid_inject_count",
  "invalid_code",
  "invalid_json",
  "invalid_keyword",
  "invalid_range",
  "invalid_request",
  "invalid_rrule",
  "invalid_snapshot",
  "invalid_state",
  "invalid_store",
  "invalid_store_id",
  "invalid_time",
  "invalid_transition",
  "invalid_visit_date",
  "line_api_error",
  "line_not_reachable",
  "missing_database",
  "no_active_resource",
  "not_applicable",
  "not_found",
  "not_no_show",
  "not_pending",
  "outside_business_hours",
  "overlapping_reservations",
  "owner_email_unset",
  "phone_hash_mismatch",
  "range_too_large",
  "reservation_linked",
  "reservation_not_found",
  "resource_not_available",
  "same_customer",
  "service_not_available",
  "slot_unavailable",
  "source_blocked",
  "stale_snapshot",
  "store_closed",
  "store_has_no_calendar",
  "store_not_found",
  "sweep_failed",
  "target_already_merged",
  "unsupported_freq",
  "write_failed",
  // -- src/routes/admin-api.ts (direct admin API response codes) --
  "invalid_allergy_notes",
  "invalid_birth_date",
  "invalid_display_name",
  "invalid_display_name_kana",
  "invalid_email",
  "invalid_gender",
  "invalid_phone",
  "memo_too_long",
  "missing_treatment_notes",
  "no_fields",
  "notes_too_long",
  "referrer_name_too_long",
  "query_failed",
  "result_too_large",
  // -- src/routes/shared.ts (admin gate / period filter parse) --
  "invalid_filter",
  "invalid_status",
  // -- shared admin-mutation rate limit (authenticateAdminRoute /
  //    requireAdminContext / guardConflictAction → 429) --
  "rate_limited",
] as const;

export type AdminApiFailureCode = typeof ADMIN_API_FAILURE_CODES[number];

export const ADMIN_API_FAILURE_CODE_SET: ReadonlySet<AdminApiFailureCode> =
  new Set(ADMIN_API_FAILURE_CODES);

export const isAdminApiFailureCode = (value: unknown): value is AdminApiFailureCode =>
  typeof value === "string" && ADMIN_API_FAILURE_CODE_SET.has(value as AdminApiFailureCode);
