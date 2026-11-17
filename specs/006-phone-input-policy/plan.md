# Implementation plan

Base: 3f65c69e64fd3999e415c83c14f5c6dfa928c13d, branch
006-phone-input-policy. Writer: delegated implementation agent in its own worktree.

1. Add behavioral tests at the approved seams: real public/admin HTTP APIs with
   migrated in-memory SQLite, and the actual public form in JSDOM. Preserve
   existing auth/provider test doubles only at the external provider boundary.
2. Add one shared predicate for an already-normalized new phone value. Keep
   normalizePhone and phoneExactSearchVariants unchanged. Enforce the predicate
   after successful-idempotency resolution for creation paths and only for new
   contact input, before any write. Apply it directly to profile/link new input.
3. Align public form validation/copy and the existing administrative phone-entry
   hints. Use parity fixtures to detect client/server acceptance drift. Avoid a
   new phone parser, country selector or generic transport/validation framework.
4. Run focused API/DOM suites, relevant block/lock/replay/search suites, backend
   and admin type checks, build/Knip/dry-run as appropriate; review the complete
   diff. Freeze a patch and results for parent independent review/integration.

Impact: shared phone identity reaches booking, idempotency, customer duplicate
grouping, blocking, exact search and manual phone locks. Canonical strings/hashes
must remain unchanged. Read/search and optional/masked fields are scope fences.
Existing high-impact graph warning is acknowledged; caller impact was refreshed.

Completion: checked tasks have source and command evidence. No commit, push, PR,
merge, deploy, live business write or migration in this delegated work.
