# Contract changes: admin API

All routes stay under `/api/admin`, keep administrator sign-in, the CSRF / `Sec-Fetch-Site` guard,
`no-store` headers and the existing owner / system-administrator behavior. Only the staff
approval check changes.

## Removed

| Route | Before | After |
|---|---|---|
| `POST /customer-gate/request` | issued a code by email (staff only) | not registered; the application's generic not-found response |
| `POST /customer-gate/verify` | verified a code and granted access (staff only) | not registered; the application's generic not-found response |

The error reason `customer_gate_required` is no longer produced anywhere.

## Changed for staff (store scope unchanged)

Every route below previously answered staff without a grant with
`403 {"ok":false,"reason":"customer_gate_required"}`. It now applies only the checks that already
followed the gate: a staff member needs a store binding, and per-customer routes still require the
customer to belong to the staff member's store.

| Route | Staff behavior after the change |
|---|---|
| `GET /customers?mode=list` (including the archived view) | own-store list without a grant |
| `GET /customers?q=` | own-store results; `memo` is returned instead of `null` |
| `GET /customers/:id` | own-store customer without a grant |
| `GET /customers/:id/visits` | own-store customer without a grant |
| `GET /customers/:id/reservations` | own-store customer without a grant |
| `GET /customers/:id/consents` | own-store customer without a grant |
| `POST /customers/:id/block`, `POST /customers/:id/unblock` | unchanged role and scope rules, no grant |
| `POST /customers/:id/archive`, `POST /customers/:id/unarchive` | unchanged role and scope rules, no grant |
| `PUT /customers/:id/memo`, `PUT /customers/:id/referrer`, `PATCH /customers/:id/profile` | own-store customer without a grant |
| `PUT /customers/:id/visits/:visitId/notes` | own-store customer without a grant |
| `POST /customers` | creates a customer for the staff member's own store without a grant |

Out-of-scope requests keep today's responses (for example `403 {"ok":false,"reason":"forbidden"}`
for another store's customer or a staff member without a store).

## Staff customer-list views

`GET /customers?mode=list` (any page, including the archived view) by a staff member writes one
activity row per staff member per JST day: action `customer.list_view`, target `admin_user`/the
staff id, metadata `{"adminStoreId": "<store>"}`. Owners and system administrators are not
recorded; `?q=` search is not recorded. A request that a browser marks as coming from another
site (`Sec-Fetch-Site: cross-site` or `same-site`) is recorded in its own row (id suffix and
metadata `fetchSite`), so a forged early request cannot claim the day's row and a client that sends
the header cannot avoid the record (at most three rows per staff member per day). The activity log shows the staff
member's name: `GET /audit-logs` returns `actorName`, resolved through `admin_users.staff_member_id`
(added 2026-10-14 after review). A failed write never fails the list. It is reported to
error monitoring unless it is a transient D1 error (for example the weekly export lock), which is
only logged, as for other failures that do not affect the response.

## Admin SPA

- No approval card on the customer list, customer detail or reservation detail.
- No calls to the removed endpoints.
- Activity-log labels for `customer_gate_code_requested`, `customer_gate_verified` and
  `customer_gate_verify_failed` remain, because historical audit rows keep those actions.
- `customer.list_view` is shown as 顧客一覧を表示.
