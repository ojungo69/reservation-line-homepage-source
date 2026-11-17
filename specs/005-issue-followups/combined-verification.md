# Combined local verification

The [combined release scope](release-scope.md) passed these checks after exact
integration of the separately frozen 005 and 006 changes:

| Check | Result |
| --- | --- |
| Backend unit coverage | 188 files, 4,301 tests passed |
| Administrative app coverage | 88 files, 957 tests passed |
| Worker tests | 5 files, 35 tests passed |
| Workflow script tests | 24 tests passed |
| Backend and administrative TypeScript | Passed |
| Knip, administrative build, Wrangler dry-run | Passed |
| Root and administrative dependency audits | Zero vulnerabilities |
| Independent Spec, Standards/security and Ponytail review | Zero must-fix or should-fix findings |
| Diff whitespace and feature-document links | Passed |

The first simultaneous full runs produced one backend and four administrative
test timeouts. The unchanged full coverage suites then passed sequentially with
four workers. No test timeout, source, dependency or quality configuration was
changed to obtain that result.

The refreshed graph maps 30 changed symbols to six expected customer-creation
and reservation-form flows, reporting HIGH risk without an incomplete-result
flag. This is an impact warning, not an additional failing test. All changed
source, fixtures and tests matched the reviewed frozen bytes. React callers
that the graph did not resolve were also checked directly in source.

These checks prove local behavior only. Public actual-main CI/Sonar, private
fixed-revision adoption, staging, production promotion and live verification
remain open in [tasks](tasks.md). No database guard, data conversion or Minimo
activation was included.
