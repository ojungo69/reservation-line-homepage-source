# Implementation Plan: One-store OSS onboarding

**Branch**: `feat/oss-onboarding-20261007` | **Date**: 2026-10-07 | **Spec**: [spec.md](spec.md)

## Summary
Add a separate one-store SQL bootstrap and operator installation guide. Reuse the earlier OSS
project's stage sequence, the application's pending-owner identity binding and native Wrangler.
No application behavior or platform/authentication architecture changes are needed.

## Technical Context
- Language/version: existing SQL, Markdown and TypeScript tests; Node 24.
- Dependencies: existing Wrangler, Vitest and node:sqlite; no additions.
- Storage: all existing D1 migrations, followed by a new fictional bootstrap.
- Testing: public-only publication-config suite, existing auth/reservation suites, isolated local D1.
- Platform: existing Cloudflare Workers/Hono/D1 application.
- Scope: README.md, docs/INSTALL.md, seeds/bootstrap.sql, test/publication-config.test.ts and this spec.
- Constraints: no src/migration/config/package/workflow edits, real data, provider provisioning or
  changes to private production; existing development fixtures remain separate.

## Constitution Check
PASS before and after design: existing contracts and dependencies reused; fictional data only;
verified Access identity remains required; initialization refuses existing core data; local/fixture
checks and operator live-provider checks are reported separately; public CI/Sonar remain mandatory.

## Project Structure
- README.md: maintained repository role and entry point to installation.
- docs/INSTALL.md: local bootstrap, operator-owned remote setup, readiness and verification gates.
- seeds/bootstrap.sql: one fictional store, pending human owner and bookable sample relations.
- test/publication-config.test.ts: new bootstrap contracts in the existing public-only suite.
- specs/001-oss-onboarding/: requirements, research, data model, contract, quickstart and tasks.

## Implementation and Impact
1. Add failing tests for fresh schema/bootstrap, public options, verified-owner binding and existing
   data refusal. Reuse SqliteD1Database without its four-store factory.
2. Add SQL with the first INSERT refusing stores/admins/customers/reservations via the existing
   NOT NULL constraint; do not use UPSERT or overwrite. Follow with canonical store-login owner,
   resource, service/link and opening hours. SQL failure on repeated use preserves identity state.
3. Add the guide and README role clarification. Native --local/--persist-to commands isolate state.
4. Run focused/native verification and normal security/diff review; verify tasks once; publish PR
   through existing full public CI/security/Sonar and merge after valid comments are resolved.

## Verification Boundaries
Agreed by task scope: applying the distribution SQL to a migrated database, existing public
reservation interfaces, and the existing verified-human owner-binding interface. Do not create
new test-only application paths or authentication exceptions. Native local health/options confirm
actual serving. Real Access/LINE/Google/Turnstile booking remains an operator-account gate.

## Security and Rollback
Reject initialization before adding data when core records exist. Never reset or reactivate owners.
Fixtures use only example.invalid identities. Remote commands target an operator-created database,
with row-count/owner checks before enabling real bookings. Restore a disposable local state from a
new path when needed; never delete live data. Revert this public-only feature through a normal PR;
private production remains pinned to its existing corresponding application source.

## Complexity Tracking
No new runtime code, dependencies, provisioning tools, frontend wizard or architecture layer.
