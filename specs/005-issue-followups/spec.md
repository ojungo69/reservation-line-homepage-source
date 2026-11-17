# Validated issue correctness follow-ups

Date: 2026-11-17. Baseline: public main 3f65c69e64fd3999e415c83c14f5c6dfa928c13d.

## Outcomes

1. A Google outbound echo matches only while its actual expiry is strictly in the future. Equivalent ISO and SQLite timestamp values have equivalent ordering. Existing calendar/event/reservation/action/etag scope stays mandatory.
2. Settings typing accurately represents the intentional staff-role omission of the staff list. Successful service-create fixtures use the accepted zero post-buffer sent by the real UI.
3. A meaningful regression connects representative UI-generated input with actual server validation. Nonzero post-buffer rejection remains intentional.

## Scope

Reuse current transport, responses, native SQLite and test helpers. Preserve authorization, idempotency, claims, retry caps, query/watch provenance and failure recovery. Change only the expiry predicate and proven settings contract mismatch plus required callers/tests. No migration, dependency, endpoint or shared RPC adapter is required.

Other validated backlog items continue as separate research/operational work. Phone policy, generic compatibility, install policy and product extensions do not silently enter this batch. Minimo release/activation remains held.

## Acceptance

- Actual importer regression: before/at/after now, same/different UTC day, ISO/SQLite/mixed formats, malformed/null expiry and different/null etags. Invalid expiry does not suppress work. Keep explicit synthetic calendar ownership.
- Privileged/staff settings responses and all affected consumers typecheck. Real UI zero buffer succeeds and nonzero fails at the actual boundary, beyond a copied mock fixture.
- Focused tests, relevant Worker/frontend checks, actual compilers, independent Standards/Spec and applicable security review pass.
- Public PR and actual-main CI/Sonar precede fixed private adoption. Preserve all60 migrations/quality/overlays, verify staging, promote exact private SHA and verify live.

## Nonclaims

The observed echo defect requires an identical etag. New-edit suppression and data loss have not been demonstrated. Regressions do not create real bookings/provider writes or send notifications.
