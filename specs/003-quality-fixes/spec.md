# Feature Specification: Verified quality fixes (October 2026)

**Feature Branch**: `feat/quality-fixes-20261014`

**Created**: 2026-10-14

**Status**: Approved scope

**Input**: Owner request 2026-10-14: "fix other improvements too". A multi-lens review of the
application found defects; each finding was confirmed in code by two independent reviewers. The
owner approved the small and medium fixes, moving dependency updates to this repository, and a
shared cache for public availability. Larger redesigns and legal wording are handled separately.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Staff and owners see trustworthy state and safe actions (Priority: P1)

Admin screens never present a failed fetch as "no data", never offer an action the server will
refuse, keep half-entered work, and follow the current day and store.

**Why this priority**: Wrong state on the shared iPad leads to double work and missed bookings.

**Independent Test**: With mocked API failures and fixtures, open each affected screen and action.

**Acceptance Scenarios**:

1. **Given** a pending reservation whose customer left the LINE friends list or whose approval
   deadline passed, **When** staff view it, **Then** approve is disabled with the reason and bulk
   approval excludes it.
2. **Given** the all-stores timeline, **When** staff tap an empty slot, **Then** the new-reservation
   panel opens with that slot's store and resource selected.
3. **Given** the settings or menu fetch fails, **When** the screen renders, **Then** it shows an
   error with a reload action instead of an empty state; customers and activity pages do the same.
4. **Given** an invalid or too-long reservation search range, **When** staff search, **Then** the
   reason is shown next to the dates and stale rows are not shown as current.
5. **Given** the schedule left open on "today" past midnight JST, **When** the day changes,
   **Then** it moves to the new day; a manually chosen day stays.
6. **Given** a half-filled new reservation, unsaved business hours, or a create dialog opened after
   changing the store filter, **When** staff dismiss, switch tab or store, or open the dialog,
   **Then** they are asked before losing work and the dialog uses the current store.
7. **Given** the administrator session expired, **When** a save fails, **Then** the message says to
   sign in again.

---

### User Story 2 - Customers finish booking without dead ends or misleading information (Priority: P1)

**Why this priority**: Every dead end on the public form is a lost booking.

**Independent Test**: Drive the public form with fixtures for network failure, slow security check,
long-lived tab, many menus and a booking cap of one.

**Acceptance Scenarios**:

1. **Given** the network fails during submit, **When** the customer is on the confirm step,
   **Then** they see the error there and the retry uses a fresh security token.
2. **Given** a pending request, **When** the customer reads the confirm, success or my-reservations
   screen, **Then** they learn that unconfirmed requests are cancelled after 24 hours.
3. **Given** my-reservations, **When** a reservation is shown, **Then** only the start time appears
   (no end time revealing treatment length).
4. **Given** a background availability refresh, **When** nothing changed, **Then** the list is not
   rebuilt or re-announced; a background failure keeps the last list.
5. **Given** initialization or the security check fails, **When** the message appears,
   **Then** it offers a reload or retry next to the affected control.
6. **Given** a whitespace-only name, full-width phone digits, a stale date list in a tab left open
   overnight, or more than 12 menus, **When** the customer continues, **Then** they get a specific
   message or a corrected value instead of a generic failure or silent truncation.
7. **Given** a store whose cap allows one active booking, **When** a booking succeeds,
   **Then** the screen does not invite an immediate second booking that will be refused.

---

### User Story 3 - Public availability survives heavy anonymous polling (Priority: P1)

**Why this priority**: Unlimited anonymous availability calls each query the calendar provider;
if its quota is exhausted every slot shows as unavailable for every customer.

**Independent Test**: Repeat identical availability requests across isolates in one data center;
the provider is called once per cache window per store, calendar and range.

**Acceptance Scenarios**:

1. **Given** the same availability request from many visitors served by one data center within
   the cache window, **When** they arrive, **Then** the calendar provider is queried at most once
   per window for that data center (the shared cache is not replicated between data centers).
2. **Given** the shared cache is unavailable, **When** a request arrives, **Then** behavior falls
   back to today's per-instance cache without failing the request.

---

### User Story 4 - Admin screens work with assistive technology and on phones (Priority: P2)

**Acceptance Scenarios**:

1. Toggles, selects, search boxes and form fields in settings, menu, activity, conflict, customer
   and LINE-friend screens have accessible names and states.
2. The header shows the current store on phones, and the store menu marks the selected store.
3. Confirm dialogs name the action on the confirm button and use the destructive style for
   destructive actions.
4. Booking-rule settings live under a tab whose name matches its content.
5. Staff searching by phone learn that the full number is required, and a name search whose
   results exceed the 20-row result limit says that the list was cut off.

---

### User Story 5 - The server returns correct results and fails clearly (Priority: P2)

**Acceptance Scenarios**:

1. The approval-time LINE reachability check times out and distinguishes "not reachable" from
   "could not check".
2. The admin slot picker does not offer slots inside store closures or in the past.
3. External blocks are filtered to the viewed period and status before the 200-row limit is
   applied, so the viewed period is always returned regardless of older history; when more than
   200 rows match, the response says so and the schedule shows a warning. Invalid filters are
   rejected with a validation error for every role.
4. Customer list pages never repeat or skip rows when sort keys tie.
5. A reminder offset of 0 is rejected instead of silently disabling the reminder.
6. Conflict-resolution reasons (including the all-day closure reason) and resolution notes longer
   than 500 characters are rejected instead of silently dropped.
7. A failed revert after a lost conflict-resolution race is reported to error monitoring.
8. Unused code paths found by the review are removed.

---

### User Story 6 - Dependency updates reach the private deployment (Priority: P3)

**Acceptance Scenarios**:

1. Automated dependency update requests are opened against this repository with the existing
   cooldown, grouping and ignore rules.
2. Authorization documentation names functions instead of line numbers, and a test prevents line
   anchors from returning.

### Edge Cases

- Approval deadlines are compared in absolute time; the server stays the final check.
- The shared availability cache must not cache provider failures longer than today's window.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Admin screens MUST distinguish fetch failure from empty data and offer a reload.
- **FR-002**: Admin screens MUST NOT enable actions the server refuses for known, displayed reasons.
- **FR-003**: Admin screens MUST protect unsaved input from accidental dismissal or context change.
- **FR-004**: The public form MUST show submit failures on the step the customer is on and MUST
  NOT reuse a spent security token.
- **FR-005**: Customer-facing screens MUST NOT reveal treatment length.
- **FR-006**: Background refreshes MUST NOT rebuild unchanged lists or replace them on failure.
- **FR-007**: Availability results from the calendar provider MUST be shared across instances in
  the same data center for the existing cache window, with a fallback to the per-instance cache.
- **FR-008**: Interactive controls in the listed admin screens MUST have accessible names and states.
- **FR-009**: Server endpoints in User Story 5 MUST return correct, complete results or a specific
  error code.
- **FR-010**: Dependency update automation MUST target this repository.
- **FR-011**: No new runtime dependency is added. Existing authorization, store scoping and
  write-time actor checks stay unchanged.
- **FR-012** (review follow-ups of specs/002, added 2026-10-14): a staff customer-list view that a
  browser marks as coming from another site is recorded in its own row so it can neither claim nor
  avoid the day's record; the activity log names the staff member behind each staff action; the
  LINE ID-token email claim is not read, because nothing uses or stores a customer email.

### Key Entities

- **Shared availability cache entry**: provider busy intervals per store, calendar and date range,
  kept for the existing window.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Each confirmed finding in research.md has a test or a recorded manual check.
- **SC-002**: Zero admin screens in scope show an empty state when their fetch failed (tests).
- **SC-003**: Identical availability requests within the cache window cause one provider query per
  colo instead of one per instance (test with a counting fake).
- **SC-004**: All existing suites, typechecks, knip and the admin build pass.

## Assumptions

- Deferred with reasons in research.md: changes to the fragile access module, request-path
  performance tweaks with low value, the external-browser login state restore, the structural
  conflict-resolution rewrite, and legal wording (owner review, private overlays).
- Workers Cache API is available on the production custom domain; on workers.dev the per-instance
  cache still applies.
