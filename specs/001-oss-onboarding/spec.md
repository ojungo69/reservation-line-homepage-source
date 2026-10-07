# Feature Specification: One-store OSS onboarding

**Feature Branch**: `feat/oss-onboarding-20261007`
**Created**: 2026-10-07
**Status**: Ready for implementation
**Input**: Make the existing public production-source repository the primary OSS development
location and reuse the earlier OSS project's installation guidance.

## User Scenarios & Testing

### User Story 1 - Start one independent installation (Priority: P1)
An operator can initialize an empty installation with one fictional store and one pre-registered
owner, then inspect the store's available services and capacity without importing another business.

**Why this priority**: Four-store development fixtures and missing initial administration currently
prevent a clear first-install path.
**Independent Test**: Apply all current migrations and the bootstrap data to a fresh database;
inspect the public options and owner identity behavior.
**Acceptance Scenarios**:
1. Given a fresh installation, initialization creates exactly one store, menu, resource and owner.
2. Given the owner's verified identity, first login binds that identity once; unrelated identities
   remain unregistered and disabled owners cannot sign in.
3. Given existing store, administrator, customer or reservation data, initialization refuses before
   adding or replacing data. Repeating initialization also refuses without changing identities.

### User Story 2 - Follow the installation gates (Priority: P2)
An operator can distinguish local model verification from accepting real bookings, and can find
which account resources, authentication, provider settings and notices they must configure.

**Why this priority**: A running development page is insufficient evidence for real booking use.
**Independent Test**: Follow the documented local commands on isolated state and review each remote
setup gate against the actual bindings and application routes.
**Acceptance Scenarios**:
1. The documented local path produces a healthy instance with exactly one fictional store.
2. The guide identifies owner registration, authenticated administration, provider setup, legal
   content and source publication as separate completion checks.
3. The guide identifies the public source as the maintained full application and the older OSS
   project as a distinct implementation whose setup sequence informs this guide.

### Edge Cases
- Existing or partially initialized data; repeated execution; changed or disabled owner identity.
- Wrong login email or a different verified subject after binding.
- Placeholder credentials, missing calendar, and Google live-availability enabled prematurely.
- Initial state used by migration-based development tests must retain its four-store fixtures.

## Requirements

### Functional Requirements
- **FR-001**: Supply a separate fictional one-store bootstrap; retain the development fixture.
- **FR-002**: Pre-register one human owner using the existing verified-identity binding contract.
- **FR-003**: Refuse existing core data without overwriting identities or reservations.
- **FR-004**: Supply a bookable sample menu, capacity resource, mapping and opening hours.
- **FR-005**: Document isolated local verification and all externally configured installation gates.
- **FR-006**: Preserve runtime authentication, dependencies, quality gates and private operations.
- **FR-007**: State which checks are local/fixture-based and which require the operator's accounts.
- **FR-008**: Reuse installation guidance without copying the earlier app's storage/authentication.

### Key Entities
- Installation: operator-owned resources and credentials, isolated from other businesses.
- Store: one fictional location with an active menu, resource and opening hours.
- Owner: pre-registered human identity bound only after the existing identity verifier succeeds.

## Success Criteria

### Measurable Outcomes
- **SC-001**: A fresh installation exposes exactly one store with a usable menu and resource.
- **SC-002**: Owner binding succeeds once; wrong email, wrong later identity and disabled access fail.
- **SC-003**: Repeated or existing-data initialization leaves existing records unchanged.
- **SC-004**: The local health/options checks pass using isolated state and documented commands.
- **SC-005**: Existing CI/security/Sonar pass without changing their policies or application behavior.

## Assumptions
- This slice supplies an operator-run installation path, not automatic external-account provisioning.
- Cloud-provider configuration and real provider credentials are supplied by each installing owner.
- Live provider booking validation remains an explicit operator step; fixtures do not prove it.
- The previous OSS repository and its open work remain available; archival is a later decision.
