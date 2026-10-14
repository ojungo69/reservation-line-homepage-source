# Verification: Remove the staff customer-tab approval code

Branch `feat/remove-customer-gate-20261014`, base `d2307b0`.

## Validation (T010)

| Check | Result | Revision |
|---|---|---|
| `npm run typecheck` | PASS | 3263d83 |
| `npm run admin:typecheck` | PASS | 3263d83 |
| `npm run knip` | PASS | 3263d83 |
| `npm run test:unit` | PASS, 170 files / 3,687 tests | 3263d83 |
| `npm run admin:test` | PASS, 73 files / 687 tests | 3263d83 |
| `npm run test:worker` | PASS, 5 files / 35 tests | 1b6c168 (no Worker-suite inputs changed after) |
| `npm run admin:build` | PASS | 1b6c168 |
| Leftover search (quickstart.md, excluding `migrations/`) | only the three kept audit labels with their assertions and the two removed-endpoint checks in the new test | 3263d83 |

Test-first evidence: `test/admin-customer-staff-access.test.ts` failed before the removal
(43 of 46 at the time, all for the gate: `403 customer_gate_required`, a `null` memo, live
code endpoints) and an independent verifier reproduced 46/46 failures against an archive of the
base commit. The list-view day boundary was mutation-checked: computing the day in UTC instead of
JST makes the day-change test fail.

## Review (T011)

| Review | Result |
|---|---|
| Codex security review (read-only, two passes incl. final state) | `ok: true`, 0 vulnerabilities |
| Two-axis review (standards, spec) | findings below |
| Adversarial authorization review | no confirmed finding (cross-store, storeless, mid-request revocation, audit-write abuse, stale client all refuted with code evidence) |
| cubic CLI | 0 issues |
| semgrep (`p/typescript`, `p/owasp-top-ten`, `p/secrets` on changed server files) | 0 findings (18 internal matching errors in rule evaluation) |
| CodeRabbit CLI | did not start (service error, two attempts) |
| ponytail review | Ship; one optional lean item (empty wrapper element) left to avoid a large re-indent |

Dispositions:

| Finding | Disposition |
|---|---|
| Matrix row for store logins still described the removed grant cleanup | fixed |
| List-view day computed a second way instead of `jstDayKey` | fixed (reuse) |
| Why the list-view target is the actor | comment added |
| Deleted comment still explained the Case B canonical row | restored |
| Failure-reporting and `system_admin` exclusion untested | tests added |
| Spec claimed pickers display the memo | spec corrected (the search returns it) |
| Remember recorded list views in memory to skip repeat writes | rejected: one indexed write per list page is negligible at the expected load, and module state would leak across test databases |
| Note the shared `/customers/*` prefix for future guards | rejected: no guard to attach it to |

## Task verification (T012)

`verify-tasks-report.md`: T001-T009 and T013 VERIFIED, no flagged items.
