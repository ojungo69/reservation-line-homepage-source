# Feature Specification: Remove the staff customer-tab approval code

**Feature Branch**: `feat/remove-customer-gate-20261014`

**Created**: 2026-10-14

**Status**: Ready for planning

**Input**: Owner decision 2026-10-14: remove the owner-approval one-time code that staff must enter
before opening the customer tab ("customer gate"). Staff keep seeing only their own store's
customers. The approval records are dropped by a separate later change.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Staff open their store's customers without a code (Priority: P1)

A staff member opens the customer tab and immediately sees their own store's customers. They can
open a customer, read and edit memo, profile and chart entries, and view consents and visit history.
No owner-delivered code and no approval card appear.

**Why this priority**: The approval step blocks daily work, and the owner decided that the existing
administrator sign-in plus store scoping is sufficient.

**Independent Test**: As a staff member of store A who never entered a code, open the list and a
customer detail and save a memo; all succeed. Customers that belong only to store B stay refused.

**Acceptance Scenarios**:

1. **Given** a staff member of store A who never entered a code, **When** they open the customer
   tab, **Then** store A's customer list is shown and no code card appears.
2. **Given** the same staff member, **When** they open a store A customer and save a memo, profile
   or chart entry, **Then** the save succeeds.
3. **Given** the same staff member, **When** they reach a customer that belongs only to store B
   through the list, search, a direct link, detail, memo, chart, consents or visit history,
   **Then** access is refused exactly as today.
4. **Given** a staff member without a store binding, **When** they open the customer tab,
   **Then** access is refused exactly as today.

---

### User Story 2 - Reservation work no longer waits for approval (Priority: P1)

In the schedule's reservation detail, staff save the treatment memo for their own store's customer
without being sent to the customer tab for a code. The customer search behind the
reservation-creation picker returns each in-scope customer's memo again instead of a blank one.

**Why this priority**: The treatment memo is written during the visit; an approval detour risks
losing the draft and delays the next customer.

**Independent Test**: As a staff member of store A without any approval, save a treatment memo from
a store A reservation detail and search customers by name; both succeed and stay limited to store A.

**Acceptance Scenarios**:

1. **Given** a staff member of store A, **When** they save a treatment memo from a store A
   reservation detail, **Then** it saves without an approval prompt.
2. **Given** a staff member of store A, **When** they search customers by name or phone,
   **Then** the results include each customer's memo and contain only store A customers.

---

### User Story 3 - Owners and audit history stay intact (Priority: P2)

Owners and system administrators see no change. Past audit entries for code requests and
verifications still display readable labels. No customer-tab code email is ever sent again.

**Why this priority**: Removal must not break other roles or make the existing audit history
unreadable.

**Independent Test**: As an owner, use the customer tab; view an activity log containing past code
entries; call the former code endpoints; change a staff member's role.

**Acceptance Scenarios**:

1. **Given** an owner, **When** they use the customer tab, **Then** behavior is unchanged.
2. **Given** audit history with past code request or verification entries, **When** the activity
   log is viewed, **Then** those entries keep their readable labels.
3. **Given** any user, **When** they call the former code request or verification endpoints,
   **Then** the application answers with its generic not-found response and sends no email.
4. **Given** an administrator's role change, deactivation or re-registration, **When** it is
   saved, **Then** it succeeds without touching the former approval records.

---

### User Story 4 - The owner can see when staff opened the customer list (Priority: P2)

With the code gone, the owner keeps a light trace: the activity log shows, once per staff member
per day, that they opened the customer list. No customer data is recorded.

**Why this priority**: Owner-approved replacement for the trace the approval step used to leave.

**Independent Test**: As staff, open the customer list several times on one day and once after
midnight; as owner, open it once; then read the activity log.

**Acceptance Scenarios**:

1. **Given** a staff member, **When** they open the customer list for the first time on a JST
   day, **Then** one activity entry is written; further list pages that day write nothing.
2. **Given** the JST date changes, **When** they open the list again, **Then** a new entry is
   written for the new day.
3. **Given** an owner or system administrator, **When** they open the list, **Then** nothing is
   recorded. Customer search used by reservation creation is not recorded either.
4. **Given** the entry cannot be written, **When** staff open the list, **Then** the list still
   loads; the failure is reported to error monitoring, except transient database-maintenance
   errors, which are only logged because the list itself is unaffected.

---

### Edge Cases

- An admin page opened before deployment may still call the removed endpoints. The server answers
  not-found and never issues a code; after reload the page has no card.
- Approval records remaining in the database are ignored by the application and are removed by a
  later, separate schema change once this version runs in production.
- A staff member whose store binding was removed is still refused.
- Rate-limit counters created by the removed feature expire on their own; nothing reads them.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST NOT require an owner-approval code or grant for staff to read or
  change their own store's customers in any customer-tab or reservation-detail flow.
- **FR-002**: The system MUST keep every existing staff store-scope restriction unchanged (own
  store only; no store binding means refusal; merged and archived customer rules unchanged).
- **FR-003**: Customer search results for staff MUST include the memo of each customer within the
  staff member's store scope.
- **FR-004**: The code request and code verification capabilities MUST be removed entirely: no
  endpoint, email, approval card, client hook, dedicated error code or error message remains.
- **FR-005**: Administrator role and active-state changes and administrator registration MUST stop
  referencing the former approval records.
- **FR-006**: After this change no application code or test may read or write the former approval
  records. The immutable historical migration that created them MUST stay unchanged.
- **FR-007**: Activity-log labels for historical code request and verification entries MUST stay
  readable.
- **FR-008**: Owner and system-administrator behavior MUST stay unchanged.
- **FR-009**: Documentation that describes staff authorization MUST describe the new behavior.
- **FR-010**: This change MUST NOT add a dependency, configuration value or schema change.
- **FR-011**: The first customer-list view of each staff member per JST day MUST be written to the
  activity log without customer data; owners, system administrators and customer search are not
  recorded, and a failed write MUST NOT fail the list request. Failures follow the project's
  monitoring policy: reported, except transient database errors that do not affect the response.

### Key Entities

- **Staff member**: administrator with the staff role, bound to exactly one store.
- **Customer**: belongs to stores through reservations, valid visits or manual registration
  (unchanged).
- **Former approval record**: short-lived code and grant rows; unused after this change and dropped
  later.
- **Audit entry**: append-only history; existing entries keep their labels.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Staff reach their store's customer list by opening the tab, with zero codes requested
  (automated tests and the staging check).
- **SC-002**: Every customer route that previously required the code is reachable by in-scope
  staff without a grant, and every such route still refuses out-of-scope staff (one automated
  check per route).
- **SC-003**: Zero customer-tab code emails are sent after deployment.
- **SC-004**: Zero references to the former approval records remain in application code and tests.
- **SC-005**: Historical activity-log entries render with readable labels (automated test).
- **SC-006**: Exactly one list-view entry per staff member per JST day (automated test across a
  day boundary).

## Assumptions

- The owner accepts that signed-in staff can read and edit their own store's customer data at any
  time; protection relies on the existing administrator sign-in and store scoping.
- The approval table is dropped by a separate later change after this version is deployed, so a
  running older version never meets a missing table.
- Notification email settings used by other features stay as they are.
- Out of scope: owner and system-administrator permissions, store-scope rules, and the separately
  tracked write-time re-authorization work.
