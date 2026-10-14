# Tasks: Verified quality fixes (October 2026)

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md)

Every task adds or updates a test that fails before the fix (or records why a manual check is the
only seam), then runs the validation set in plan.md.

## Setup

- [X] T001 Record confirmed findings, decisions, deferrals and clusters in `specs/003-quality-fixes/`.

## User Story 1 (P1): trustworthy admin state and safe actions

- [ ] T002 [P] [US1] A1: F4, F5, F16, F32 in `admin-app/src/components/schedule/pending-approvals-card.tsx`, `admin-app/src/pages/schedule.tsx`, `admin-app/src/components/schedule/reservation-detail-panel.tsx`.
- [ ] T003 [P] [US1] A3: F15, F33, F43, F44 and the customer-page part of U3 in `admin-app/src/components/schedule/reservation-create-panel.tsx`, `admin-app/src/pages/customers.tsx`, `admin-app/src/pages/activity.tsx`, `src/admin/customers.ts`.
- [ ] T004 [P] [US1] A4: F31, F35, F36, F37, F45, U1, U2 and the LINE-friend part of U3 in `admin-app/src/pages/reservations.tsx`, `admin-app/src/lib/error-messages.ts`, `admin-app/src/hooks/use-admin-push.ts`, `admin-app/src/hooks/use-theme.ts`, `admin-app/src/components/header.tsx`, `admin-app/src/pages/line-friends.tsx`, `admin-app/src/components/line-friends/`.

## User Story 2 (P1): bookings without dead ends

- [ ] T005 [P] [US2] P1: F17, U4, U5, U7, U8 in `public/app.js` and `src/routes/public.ts` (and the shared selection limit).
- [ ] T006 [P] [US2] P2: F18, F20, F21, U6 in `public/app.js` and `public/customer/reservations.js`.

## User Story 3 (P1): shared availability cache

- [ ] T007 [P] [US3] P3: S1 in `src/google/availability-live-check.ts` with a counting-fake test.

## User Story 4 (P2): accessible admin screens

- [ ] T008 [P] [US4] A2: F6, F12, F13, F14, F29, F30 in `admin-app/src/components/settings/`, `admin-app/src/pages/menu.tsx`, `admin-app/src/pages/settings.tsx`, `admin-app/src/components/menu/`, `admin-app/src/components/staff/staff-create-dialog.tsx`, conflict dialogs.

## User Story 5 (P2): correct server results

- [X] T009 [P] [US5] B1: F9, F10, F34, F40 in `src/admin/reservations.ts`, `src/admin/operations.ts`, `admin-app/src/hooks/use-external-blocks.ts`, `src/admin/customers.ts`.
- [X] T010 [P] [US5] B2: F39 (reporting only), F41, F42, U17, U18 in `src/admin/conflict-resolutions.ts`, `src/admin/settings-reminder.ts`, `src/routes/admin-api.ts`, `src/reservations/public-options.ts`, `src/cache/kv-cache.ts` and the unused logout export.

## User Story 6 (P3): repository maintenance

- [X] T011 [US6] F24: replace line anchors with function names in `docs/admin-authz-matrix.md`; make `test/admin-authz-matrix-sync.test.ts` reject `.ts:<line>` anchors.
- [X] T012 [US6] F3: add `.github/dependabot.yml` for the root and `admin-app` npm packages with the existing cooldown, grouping and ignore rules.

## Verification and release

- [ ] T013 Merge cluster branches, run the full validation set, record results in `specs/003-quality-fixes/verification.md`.
- [ ] T014 Review correctness, over-implementation and accessibility; record dispositions in verification.md.
- [ ] T015 Verify every completed task once against files and evidence.

## Dependencies

Clusters T002-T010 are independent (separate files; A3 and B1 both touch `src/admin/customers.ts`
in different functions, merge A3 after B1). T011-T012 are independent. T013 needs all; T014 -> T015.
