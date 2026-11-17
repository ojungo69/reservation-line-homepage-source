# Tasks

- [X] T001 Capture caller impact and add failing new-input API/form regression.
- [X] T002 Implement shared predicate and five write-entry checks preserving
  legacy reads and idempotent replay.
- [X] T003 Align public and administrative input guidance; verify form parity.
- [X] T004 Verify accepted identity, blocked/role/NULL/masked/legacy/replay/lock
  contracts with focused and existing suites.
- [X] T005 Run required static/build checks, review diff, freeze patch and report.

Verification: real authenticated API policy tests (80), public form suite (27),
existing backend identity/block/search/lock suites (385), public contract suites
(94), administrative UI suites (97), Worker suites (35), both TypeScript checks,
Knip, admin build, Wrangler dry-run and git diff --check passed. The installed
Spec Kit integration omits verify-tasks; the five task completions were checked
directly against their implementation and these command results. Independent
review, combined integration and release are parent-owned and remain outside this
delegated completion.
