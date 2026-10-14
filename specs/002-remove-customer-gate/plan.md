# Implementation Plan: Remove the staff customer-tab approval code

**Branch**: `feat/remove-customer-gate-20261014` | **Date**: 2026-10-14 | **Spec**: [spec.md](spec.md)

## Summary

Delete the owner-approval one-time code that staff must enter before using the customer tab.
Every former check is removed from the customer routes and the reservation-detail chart save,
leaving the existing staff store scoping as the only staff restriction. The request and verify
endpoints, the gate module, the approval card, its client hook, the dedicated error code and the
role-change grant cleanup are deleted. Audit labels for historical gate entries stay. No schema,
configuration or dependency changes; the approval table is dropped by a later change.

## Technical Context

- **Language/Version**: TypeScript on Cloudflare Workers (Hono); React admin SPA; Node 24 tooling.
- **Primary Dependencies**: existing Hono, D1 client code, TanStack Query, Vitest and Testing
  Library. No additions.
- **Storage**: D1. No schema change here. The approval table becomes unused and is dropped by a
  separate later change after this version is in production (see Rollout).
- **Testing**: root unit suite (`npm run test:unit`), worker suite (`npm run test:worker`), admin
  suite (`npm run admin:test`), both typechecks (`npm run typecheck`, `npm run admin:typecheck`),
  `npm run knip`, `npm run admin:build`.
- **Target Platform**: Cloudflare Workers + static admin SPA.
- **Project Type**: web service with an admin single-page application.
- **Performance Goals**: one D1 query fewer per gated staff request; no new work.
- **Constraints**: store scoping unchanged; immutable migration history unchanged; public
  repository contains fictional data only; public CI and Sonar remain mandatory.
- **Scale/Scope**: the files enumerated in [research.md](research.md); removal only.

## Constitution Check

The local constitution file is an unratified template, as in the earlier specs of this project.
The governing documents are `README.md`, `CONTRIBUTING.md` (keep API/authorization/time/D1/
notification contracts; no needless dependencies or abstractions) and
`docs/admin-authz-matrix.md`.

PASS before design: an owner decision removes one authorization layer while every store-scope
contract stays; no dependency, configuration or schema change; fictional test data only.
PASS after design: each former call site keeps its store-scope check (verified per route in
research.md and asserted per route in tests); the authorization matrix is updated in the same
change.

## Project Structure

### Documentation (this feature)

```text
specs/002-remove-customer-gate/
├── plan.md
├── research.md          # removal inventory and decisions
├── data-model.md        # unused table and later drop
├── quickstart.md        # validation commands and staging check
├── contracts/admin-api.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
src/admin/customer-gate.ts            # deleted
src/routes/shared.ts                  # gate helper and body removed
src/routes/admin-api.ts               # request/verify routes and every gate call removed
src/admin/customers.ts                # memo redaction option removed
src/admin/admin-error-codes.ts        # gate error code removed
src/admin/settings-staff.ts           # grant cleanup removed
src/admin/settings-store-login.ts     # grant cleanup removed
admin-app/src/components/customers/customer-gate-card.tsx   # deleted
admin-app/src/hooks/use-customer-gate.ts                    # deleted
admin-app/src/pages/customers.tsx
admin-app/src/components/customers/customer-detail-panel.tsx
admin-app/src/components/schedule/reservation-detail-panel.tsx
admin-app/src/lib/error-messages.ts
admin-app/src/lib/audit-format.ts     # labels kept for history
test/ and admin-app/src/**/*.test.tsx # see research.md
docs/admin-authz-matrix.md
```

**Structure Decision**: existing single Worker plus `admin-app/`; no new modules.

## Implementation and Impact

1. Rewrite gate-dependent tests to the new contract first and watch them fail for the right
   reason: staff without a grant reach every former gated route for their own store; the same
   routes still refuse another store's customer and a staff member without a store; search returns
   memo for staff; the removed endpoints answer the application's generic not-found; role changes
   do not touch the approval table; historical audit labels render.
2. Remove the backend gate (module, helper, routes, call sites, memo redaction, error code, grant
   cleanup).
3. Remove the SPA gate (card, hook, gate detection in the customer page, customer detail and
   reservation detail, error message). Keep audit labels.
4. Update the authorization matrix and any operator text describing the code.
5. Verify: full suites, typechecks, knip, admin build, repository search for leftovers (SC-004).

Implementation is delegated per the routing table (row 3: the changed files are enumerable) with
the allowed file list from research.md; the parent reviews the result for correctness, scope and
over-engineering, and runs a security review because authorization changes.

## Rollout

1. Public PR: CI, Sonar and review bots must pass; merge.
2. Private adoption at the merged public SHA: update the source lock, import, reconcile the private
   overlay copies of the changed tests and authorization matrix with the same edits, update
   private-only documents and the admin registration script, pin the source offer, pass private CI
   and review, merge.
3. Staging: deploy happens on merge; verify as staff by temporarily switching one staging
   administrator to the staff role, then restore it and re-check through the live API.
4. Production: promote the verified private SHA with the documented dispatch, watch the run, and
   confirm the removed endpoints return the application's generic not-found.
5. Later change, only after step 4 is live: add a migration that drops the approval table, adopt it
   privately with the migration guard threshold raised, deploy, and confirm the table is gone.

## Security and Rollback

The owner accepted that signed-in staff can always reach their own store's customers. Store
scoping, sign-in and write-time actor checks are unchanged. Rollback before step 5 is a normal
revert and re-adoption; the table still exists. After step 5, restoring the gate would also need
the table recreated from the historical migration.

## Complexity Tracking

No violations: removal only, no new code paths, abstractions or dependencies.
