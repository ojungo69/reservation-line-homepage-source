# Tasks: One-store OSS onboarding

## Setup and foundation
- [x] T001 Resolve existing repository roles and bootstrap/schema contracts in `specs/001-oss-onboarding/research.md`.
- [x] T002 Record approved requirements, plan and validation boundaries in `specs/001-oss-onboarding/spec.md` and `specs/001-oss-onboarding/plan.md`.

## User Story 1: Fresh one-store installation
- [x] T003 [US1] Add failing bootstrap/public-options/owner-binding/refusal contracts to test/publication-config.test.ts.
- [x] T004 [US1] Implement fictional one-store initialization and existing-data guard in seeds/bootstrap.sql.
- [x] T005 [US1] Run focused tests and related existing pending-owner tests against test/publication-config.test.ts.

## User Story 2: Installation gates
- [x] T006 [US2] Add local/provider/legal/source readiness and verification guidance in docs/INSTALL.md.
- [x] T007 [US2] Update maintained repository role and installation entry point in README.md.
- [x] T008 [US2] Execute documented native Wrangler migration/bootstrap/build/dev steps and record local HTTP/browser evidence in `specs/001-oss-onboarding/verification.md`.

## Review and release
- [x] T009 Review source/bootstrap security and documentation, run native/config/diff checks, and record findings in `specs/001-oss-onboarding/verification.md`.
- [x] T010 Verify every completed task once against concrete files and evidence in `specs/001-oss-onboarding/verification.md`.


## Dependencies and parallel work
T001 -> T002 -> T003 -> T004 -> T005. Documentation drafting can proceed independently after T002;
T006/T007 and T005 precede T008. T008 -> T009 -> T010. Parent remains the only repository
writer; read-only drafts/reviews may run independently.

## Implementation strategy
Deliver the bootstrap and meaningful failure checks first, then the guide and actual local serving.
Do not provision provider accounts or alter the production import pin for this public-only slice.

## Delivery tracking
Public PR, CI/security/Sonar, merge, evidence retention and task-worktree cleanup are tracked in
work_state list oss-onboarding-source-first-2026-10-07 after implementation verification.
