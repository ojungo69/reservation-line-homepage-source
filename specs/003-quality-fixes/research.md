# Research: confirmed findings and decisions

Base: `main` after `specs/002-remove-customer-gate`. Each finding was confirmed in code by two
independent reviewers (one Opus, one Sonnet) told to refute it; IDs are the review's.

## In scope

| ID | Area | Finding | Fix direction |
|---|---|---|---|
| F4 | admin | Approve/bulk approve enabled for rows the server refuses (not a LINE friend, past deadline) | disable with reason; exclude from bulk; server stays final |
| F5 | admin | All-stores timeline slot opens create panel without store/resource | seed store from the slot's resource |
| F6 | admin | Failed settings fetch shown as empty menus/closures/store prompt | error state with reload |
| F12 | admin | Business-hours toggle is a click-only element; time selects unnamed | real toggle button with `aria-pressed`; named selects |
| F13 | admin | Labels not bound to controls in settings, menu, activity, conflict dialogs | bind ids or use the house field component |
| F14 | admin | Booking window, cap, notice and quota under a tab named リマインダー | rename the tab to match its content |
| F15 | admin | Staff phone search by visible last digits finds nothing, flat message | keep exact match; say the full number is needed |
| F16 | admin | Confirm dialog shows an unstyled 実行 next to キャンセル | name the action, destructive style, rename dismiss |
| F29 | admin | Unsaved business hours lost on tab/store switch | confirm or keep the draft |
| F30 | admin | New staff/menu dialogs use the store from page mount | reseed on open |
| F31, F45 | admin | Reservation search: stale rows, generic error for invalid ranges | inline validation, mapped server reasons, fetching state |
| F32 | admin | Schedule stays on the opening day past midnight JST | follow "today" unless the user navigated |
| F33 | admin | Customers/activity print "no data" under the error | hide empty states on error; reload |
| F35 | admin | Expired session save shows a generic toast | tell the user to sign in again |
| F36 | admin | Push reconcile failure cached for the whole page | clear the memo on failure |
| F37 | admin | Theme storage access without try/catch | guard like the density hook |
| F43 | admin | Name search silently capped at 20 | report truncation |
| F44 | admin | New-reservation sheet discards input on dismiss | confirm when dirty |
| U1 | admin | LINE friend linking: disabled buttons without reason, unlabeled filters/search | reasons, `aria-pressed`, labels |
| U2 | admin | Phone header hides current store; menu lacks selected state | show store; radio semantics |
| U3 | admin | Search inputs labeled only by placeholder | accessible names |
| F17 | public | Submit network failure invisible on confirm step; retry reuses a spent token | in-step status; fresh token |
| F18 | public | 24-hour expiry of unconfirmed requests never explained | one sentence on confirm/success/list |
| F20 | public | My-reservations shows end time (reveals duration + buffer) | show start only |
| F21 | public | Background poll rebuilds and re-announces the slot list | silent refresh; keep list on failure |
| U4 | public | Init/security-check failures without recovery | reload/retry next to the control |
| U5 | public | Whitespace name and full-width phone give generic errors | client validation, NFKC, server reason |
| U6 | public | Date list stale in long-lived tab | rebuild when the store day changes |
| U7 | public | More than 12 menus silently truncated | cap selection with message; server rejects |
| U8 | public | "Book another" offered when the cap is one | hide or pre-check the cap |
| S1 | public | Anonymous availability calls each query the calendar provider; quota exhaustion shows zero slots | shared Cache API layer for provider results |
| F9 | server | Approval LINE reachability check: no timeout, every failure = unreachable | timeout; distinct retryable code |
| F10 | server | Admin slot picker offers closures and past slots | mark unavailable |
| F34 | server | External blocks endpoint returns latest 200 of all time | filter by viewed range and status |
| F39 | server | Failed conflict revert swallowed silently | report to error monitoring (structural fix deferred) |
| F40 | server | Customer list pagination without unique tiebreaker | add id to ORDER BY |
| F41 | server | Reminder offset 0 accepted but means disabled | reject 0 at the API |
| F42 | server | Over-long conflict reasons silently dropped | 400 invalid_request |
| U17 | server | Reschedule-only lock exclusion never passed | remove the parameter |
| U18 | server | Unused cache keys and logout export | delete them (knip configuration unchanged) |
| F24 | docs | Authorization matrix cites stale line numbers | function names; test forbids line anchors |
| F3 | repo | Dependency updates cannot flow since the source split | add update automation here |

## Deferred, with reasons

- F23, F38 (`src/admin/access.ts`): the module is known to be fragile (cache identity); low impact.
- U10, U13, U14: request-path performance with small benefit for four stores.
- F22: the owner did not choose the external-browser state restore.
- F39 structural rewrite: high fix risk; only the reporting part is in scope.
- F19, U9: legal wording lives in private instance pages and needs owner review and consent
  version bumps.
- F11, F26, F27, F28, U20-U22: private operations items, handled in the private repository.

## Decisions

- **Shared availability cache**: Workers Cache API (`caches.default`) as a second layer behind the
  per-instance map, same 30-second window, never caching provider failures. KV was rejected (60 s
  minimum TTL, eventual consistency). A rate-limiting binding was deferred by the owner because
  carrier-grade NAT could block real customers.
- **Knip**: configuration is a pinned quality file for the private adoption; unchanged.
