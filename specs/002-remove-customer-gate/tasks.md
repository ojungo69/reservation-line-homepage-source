# Tasks: Remove the staff customer-tab approval code

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md),
[contracts/admin-api.md](contracts/admin-api.md), [data-model.md](data-model.md)

## Setup

- [X] T001 Record decisions, removal inventory, contracts and validation in `specs/002-remove-customer-gate/`.

## User Stories 1 and 2 (P1): staff work without a code

- [X] T002 [US1] Add `test/admin-customer-staff-access.test.ts`: for every former gated route in `contracts/admin-api.md`, a staff member of store A without any grant succeeds for a store A customer, is refused for a customer that belongs only to store B, and a staff member without a store is refused; search returns `memo` for staff; `POST /api/admin/customer-gate/request` and `/verify` return the generic not-found body. Run it before removal and confirm it fails because of the gate (403 `customer_gate_required`), not for another reason.
- [X] T003 [US1] Remove the backend gate: delete `src/admin/customer-gate.ts`; edit `src/routes/shared.ts`, `src/routes/admin-api.ts`, `src/admin/customers.ts`, `src/admin/admin-error-codes.ts` as listed in research.md.
- [X] T004 [US1] Remove approval-row cleanup from `src/admin/settings-staff.ts` and `src/admin/settings-store-login.ts`.
- [X] T005 [US1] Update backend tests: delete `test/admin-customer-gate.test.ts`; edit `test/helpers/admin-access.ts`, `test/admin-staff-customer-scope.test.ts`, `test/admin-operations.test.ts`, `test/admin-customer-chart.test.ts`, `test/admin-customer-actions.test.ts`, `test/admin-customer-consents.test.ts`, `test/admin-remaining-write-authorization.test.ts`, `test/settings-staff-self-deactivation.test.ts`, `test/settings-store-login.test.ts`, and the owner-mail caller comment in `test/operations-email.test.ts`.
- [X] T006 [US1] [US2] Remove the SPA gate: delete `admin-app/src/components/customers/customer-gate-card.tsx` and `admin-app/src/hooks/use-customer-gate.ts`; edit `admin-app/src/pages/customers.tsx`, `admin-app/src/components/customers/customer-detail-panel.tsx`, `admin-app/src/components/schedule/reservation-detail-panel.tsx`, `admin-app/src/hooks/use-customers.ts`, `admin-app/src/lib/error-messages.ts`.
- [X] T007 [US1] [US2] Update SPA tests: delete `admin-app/src/components/customers/customer-chart-gate.test.tsx` and `admin-app/src/components/schedule/reservation-detail-gate.test.tsx`; edit `admin-app/src/components/schedule/reservation-detail-panel.test.tsx` (staff edits and saves a treatment memo with no card) and `admin-app/src/pages/customers.test.tsx`.

## User Story 3 (P2): owners and history

- [X] T008 [US3] Keep the historical labels in `admin-app/src/lib/audit-format.ts` and their assertions in `admin-app/src/lib/audit-format.test.ts`; reword the comment and test titles as history.
- [X] T009 [US3] Update `docs/admin-authz-matrix.md`: remove the two routes and the approval prefixes, add a dated removal note.

## User Story 4 (P2): staff customer-list views are recorded

- [X] T013 [US4] Record the first staff customer-list view per JST day (`recordStaffCustomerListView` in `src/admin/customers.ts`, called from `src/routes/admin-api.ts`), label it in `admin-app/src/lib/audit-format.ts`, cover it in `test/admin-customer-staff-access.test.ts` and `admin-app/src/lib/audit-format.test.ts`, and document it in `docs/admin-authz-matrix.md`.

## Verification and release

- [X] T010 Run the validation in quickstart.md and the leftover search; record results in `specs/002-remove-customer-gate/verification.md`.
- [X] T011 Review correctness, over-implementation and security; record findings and dispositions in `specs/002-remove-customer-gate/verification.md`.
- [X] T012 Verify every completed task once against files and evidence in `specs/002-remove-customer-gate/verification.md`.

## Dependencies

T001 -> T002 -> T003/T004 -> T005; T006 -> T007; T008 and T009 are independent. T010 needs all
implementation tasks; T011 -> T012. One writer edits the repository at a time.

## Delivery tracking

Public PR, private adoption, staging check, production promotion and the later table drop are
tracked outside this repository.
