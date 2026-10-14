# Implementation Plan: Verified quality fixes (October 2026)

**Branch**: `feat/quality-fixes-20261014` | **Date**: 2026-10-14 | **Spec**: [spec.md](spec.md)

## Summary

Fix the confirmed findings in [research.md](research.md) with the smallest change each, using
existing components, hooks and helpers. Add a shared Cache API layer for calendar-provider busy
intervals and dependency update automation. No new dependency, schema or authorization change.

## Technical Context

- **Language/Version**: TypeScript (Workers, Hono), React admin SPA, plain JavaScript public pages.
- **Primary Dependencies**: existing only.
- **Storage**: D1 unchanged; Workers Cache API for provider busy intervals (no binding needed).
- **Testing**: `npm run typecheck`, `npm run admin:typecheck`, `npm run test:unit`,
  `npm run test:worker`, `npm run admin:test`, `npm run knip`, `npm run admin:build`.
- **Constraints**: knip, Sonar, Vitest and TypeScript configuration are pinned quality files for
  private adoption and stay unchanged; public HTML files are instance overlays, so copy changes
  live in shared scripts where possible; fictional data only.
- **Scale/Scope**: ~40 small fixes across admin SPA, public pages and server routes.

## Constitution Check

Unratified template; governing documents are README.md, CONTRIBUTING.md and
docs/admin-authz-matrix.md. PASS: existing contracts kept, no new dependency or abstraction,
authorization unchanged, each fix covered by a test or recorded check.

## Implementation and Impact

Work is split into independent clusters so each can be delegated and reviewed on its own:

| Cluster | Findings | Main files |
|---|---|---|
| A1 schedule and approvals | F4, F5, F16, F32 | pending-approvals-card, schedule page, reservation-detail-panel |
| A2 settings, menu, staff | F6, F12, F13, F14, F29, F30 | settings tabs, menu page and dialogs, staff dialog |
| A3 create panel, customers, activity | F15, F33, F43, F44, U3 (customers) | reservation-create-panel, customers page, activity page, customers search |
| A4 header, LINE friends, hooks | F31, F35, F36, F37, F45, U1, U2, U3 (LINE friends) | header, line-friends page and dialogs, error messages, push and theme hooks, reservations page |
| B1 server correctness | F9, F10, F34, F40 | admin reservations, operations, external-blocks hook, customers |
| B2 server cleanup and docs | F24, F39, F41, F42, U17, U18 | conflict resolutions, reminder settings, admin-api, public-options, kv-cache, authz matrix |
| P1 public submit path | F17, U4, U5, U7, U8 | public/app.js, public route parsing |
| P2 public refresh and copy | F18, F20, F21, U6 | public/app.js, public/customer/reservations.js |
| P3 availability cache | S1 | availability live check |
| R1 repository | F3 | `.github/dependabot.yml` |

Each cluster adds or updates tests for its findings and runs the full validation set.

## Rollout

Public PRs per area (admin, server, public) after the removal feature merges; private adoption at
the merged SHA together with the later table drop; staging check; production promotion.

## Complexity Tracking

No violations.
