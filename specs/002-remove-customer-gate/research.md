# Research: removal inventory and decisions

Base: `main` at `d2307b0`. Line numbers refer to that commit.

## Decisions

- **Decision**: delete the gate outright instead of disabling it behind a setting.
  **Rationale**: owner decision 2026-10-14; a dormant switch keeps code, tests and an email path
  alive for no use. **Alternatives**: configuration flag (rejected: dead code), staff loses the
  customer tab (rejected: not requested).
- **Decision**: keep the three historical audit labels and their test.
  **Rationale**: `audit_logs` is append-only and the activity page still renders old rows.
- **Decision**: keep the approval table in this change; drop it in a later migration.
  **Rationale**: deployment applies migrations before the Worker switch, so a same-release drop
  would make the still-running older Worker fail on its approval lookup.
- **Decision**: remove the 5-minute customer-list poll.
  **Rationale**: it existed only to notice a 12-hour grant expiring.
- **Decision**: remove the five error codes only the gate produced: `customer_gate_required`,
  `gate_email_failed`, `invalid_code`, `not_applicable`, `owner_email_unset`.
  **Rationale**: no other producer or consumer in `src/`, `admin-app/src`, `test/` or `scripts/`;
  the drift test only checks one direction, so leftovers would not fail CI.
- **Decision**: add a per-route matrix test for the former gated routes asserting in-scope staff
  succeed without a grant and out-of-scope staff are refused. **Rationale**: SC-002; it is the
  direct regression test for "the gate was the only protection".

## Store scope that remains at each former check

No former call site depended on the gate as its only staff protection.

| Former check | Remaining staff protection |
|---|---|
| `GET /customers?mode=list` (incl. archived) | `staffHasStore` 403, then list with `storeScope = admin.store_id` |
| `GET /customers?q=` | `staffHasStore` 403, store-scoped search, staff exact phone match, masked phone |
| `GET /customers/:id`, `/visits`, `/reservations`, `/consents` | store-scope checks in the detail and history access functions |
| `POST /customers/:id/block` / `unblock`, `archive` / `unarchive` | existing role rules plus `staffMayActOnCustomer` (store membership including archived customers) carried into the write, and write-time actor checks |
| `PUT /customers/:id/memo`, `/referrer`, `PATCH /customers/:id/profile` | `prepareCustomerMutation` keeps `assertStaffCustomerStoreScope` |
| `PUT /customers/:id/visits/:visitId/notes` | `assertStaffCustomerStoreScope` |
| `POST /customers` | staff store stamped from the authenticated identity, never the body |

Note: the customer memo is one field per customer, not per store. Staff already read it through
the customer detail; search now returns the same value for customers in their scope.

## Inventory: application code

| File | Action |
|---|---|
| `src/admin/customer-gate.ts` | delete |
| `src/routes/shared.ts` | remove the gate import, `CUSTOMER_GATE_REQUIRED_BODY` and `assertCustomerTabGate` |
| `src/routes/admin-api.ts` | remove gate imports, the `/customer-gate/request` and `/verify` routes, every `assertCustomerTabGate` call, `gateGranted` and `redactMemo` in `GET /customers` |
| `src/admin/customers.ts` | remove the `redactMemo` option; return `memo` as stored |
| `src/admin/admin-error-codes.ts` | remove the five gate-only codes |
| `src/admin/settings-staff.ts` | remove the approval-row DELETE (and its comment) from the role/active batch |
| `src/admin/settings-store-login.ts` | remove `dropDisabledGrants` and the approval-row DELETEs in cases A/B/C |
| `admin-app/src/components/customers/customer-gate-card.tsx` | delete |
| `admin-app/src/hooks/use-customer-gate.ts` | delete |
| `admin-app/src/pages/customers.tsx` | remove gate detection and card |
| `admin-app/src/components/customers/customer-detail-panel.tsx` | remove gate state, card and `suspended` prop |
| `admin-app/src/components/schedule/reservation-detail-panel.tsx` | remove the notes-gate probe, card and `suspended` prop |
| `admin-app/src/hooks/use-customers.ts` | remove the 5-minute list poll and its comment |
| `admin-app/src/lib/error-messages.ts` | remove the four gate-only codes from the union and messages |
| `admin-app/src/lib/audit-format.ts` | keep labels; reword the comment as history |

## Inventory: tests

| File | Action |
|---|---|
| `test/admin-customer-gate.test.ts` | delete; move the useful "staff without grant" coverage into the new route matrix |
| `test/helpers/admin-access.ts` | delete `grantCustomerTabGate` |
| `test/admin-staff-customer-scope.test.ts`, `test/admin-operations.test.ts`, `test/admin-customer-chart.test.ts`, `test/admin-customer-actions.test.ts`, `test/admin-customer-consents.test.ts` | drop grant setup; assert behavior without a grant |
| `test/admin-remaining-write-authorization.test.ts` | drop the gate request/verify mutation entries and standalone gate tests |
| `test/settings-staff-self-deactivation.test.ts`, `test/settings-store-login.test.ts` | delete grant-cleanup tests |
| `admin-app/src/components/customers/customer-chart-gate.test.tsx`, `admin-app/src/components/schedule/reservation-detail-gate.test.tsx` | delete |
| `admin-app/src/components/schedule/reservation-detail-panel.test.tsx`, `admin-app/src/pages/customers.test.tsx` | remove gate mocks and cases; staff save works without a card |
| `admin-app/src/lib/audit-format.test.ts` | keep label assertions; reword titles as history |
| `test/operations-email.test.ts` | drop the removed code from the comment listing owner-mail callers |
| new route-matrix test | in-scope staff succeed without a grant; out-of-scope refused; removed endpoints answer the generic not-found |

`test/admin-authz-matrix-sync.test.ts` fails unless the two removed routes leave
`docs/admin-authz-matrix.md` in the same change.

## Inventory: documentation

- `docs/admin-authz-matrix.md`: remove the two route rows and approval prefixes; add a dated
  removal note; keep earlier dated notes as history.

## Private adoption (outside this repository)

- Source lock: new commit, removed and changed file digests, overlay digests.
- Private overlay copies of the changed tests and the authorization matrix: apply the same edits.
  Their private differences are fixture strings that do not overlap the edits.
- Private-only: operations specification and credential guide text, the admin registration
  script and its test (they delete approval rows today), a dated note on the earlier spec.
- Later table drop: new migration number after the current last one, migration guard threshold
  raised in the same change.
