# Implementation plan

Baseline 3cd583d, TypeScript Workers/Hono/D1 backend and React/Vite admin. No new dependencies. Existing SPEC, auth matrix, and existing behavior are authoritative.

## Scope and impact

Admin tab identity uses index.html plus copied public favicon asset. Theme bug is local Header next-state mapping with one UI caller. LINE lists/dialogs retain current request result status. Sonar maintenance touches current source only, preserving async rejection semantics, SQL, authorization, provider order and error handling. Audit-discovered booking consent, catalog-active and notification races get separate deterministic regressions and atomic write guards only after verified findings. Minimo stays in an independent preparation branch and never enters this release.

## Sequence and ownership

1. Root: source baseline, favicon diagnosis/fix and theme menu mapping.
2. Isolated writers: Sonar refactor; LINE UI state; booking consent; notification/cron fixes. Read-only audit continues in parallel with per-slice manifests.
3. Root integrates reviewed diffs, runs backend/admin/Worker/type/build/knip/security checks required by existing CI.
4. Independent Standards and Spec reviews against the fixed baseline; repair valid findings.
5. Public PR/checks/Sonar then private fixed-SHA adoption, full gates, staging smoke and exact-SHA production promotion/live verification. No Minimo release.

## Invariants / constitution check

PASS: existing permission/store checks and D1 lock authority retained. No historical migration edits, credential disclosure, runtime flag changes or gates relaxed. Google query generation uses one new additive0059 migration; unknown legacy tokens retain their value and trigger one validated full sync before reuse. No new data model is required for favicon/theme/search/Sonar changes. Notification changes may need a new reviewed migration if a correctness guarantee cannot fit existing job state; never mutate old migrations.

## Completion / rollback

Behavioral regressions pass including delayed search, all theme states, concurrent consent and notification dispatch. Exact changed symbols reviewed with current callers when graph is stale. Reports distinguish evidence from proposal and unverified live behavior. Production adoption follows documented pipeline. Rollback uses a new reviewed targeted public revert R, followed by fixed-SHA adoption into a new private RB and the same CI/Sonar, staging and production promotion checks. R preserves applied DDL (including 0059/0060), query-version compatibility, watch-renewal token provenance and the approved quality configuration; it does not restore the old source lock or remove those safeguards. Database/data restoration is a separate operation.

## T015 follow-up: watch renewal query provenance

Scope: copy sync_token and nullable sync_query_version from the same retiring-channel snapshot in src/google/channel-watch.ts. Preserve unknown and mismatched versions without promotion; first-channel values remain NULL. No migration or importer behavior changes. Completion: real SQLite watch-to-import regressions prove validated tokens remain incremental, unknown/mismatched tokens still queue full recovery, and failed stop requests safely retire the old channel. Verify the existing Google import/webhook suites, backend typecheck and Worker suite before release review.

## Review remediation

Pin selected service durations at the booking write boundary, resolve concurrent admin idempotency before catalog failure, reclaim only expired exact settings keys, and keep burst count/end paired per detection bucket. Preserve definitely-unused LINE quota cleanup and Google attempt caps at selection, claim and stale recovery. Linked closures reject interval changes with a clear409/cancel-and-reapprove path while retaining reason-only and unlinked edits. No migration or Minimo code enters this follow-up. Completion requires deterministic SQLite failure reproductions, current callers, focused/Worker/type checks, independent code/security/lean reviews and final exact-source adoption proof before T012.
