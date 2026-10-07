# Verification: one-store OSS onboarding

## Scope and baseline
Public source base: 5b6e5df0ac6c412c29bf00f468fad287e0ce764d.
Implementation: README.md, docs/INSTALL.md, seeds/bootstrap.sql, public-only
 test/publication-config.test.ts, and this feature's artifacts. Application source, migrations,
configuration, package commands, workflows and the four-store dev fixture are unchanged.

## Red before green
- Missing bootstrap: 1 failed / 2 passed; literal failure ENOENT opening seeds/bootstrap.sql.
- Existing-data refusal before guard: 3 failed / 3 passed; expected NOT NULL refusal was absent.
- The existing-data guard then passed all 6 tests. Final focused suite: 17 passed across publication
  configuration and existing pending-owner binding suites.

## Actual local installation
Executed native Wrangler 4.129.0 against a new .wrangler/oss-install path: all 57 current migrations,
bootstrap, admin build and local dev on an isolated port. D1 counts: stores1/admins1/services1/resources1.
HTTP health pass; options: one store/menu/resource and seven hours rows; availability ready, 34 slots.
Playwright at 390px and 1280px: one Example Store / Example Appointment, no horizontal overflow,
HTTP200 for page/source, zero console errors. Browser and owned local server stopped after checks.

## Data and identity safety
Fixture tests exercise the real public-options/availability/pending-reservation implementation and
existing verified-human owner binding. Wrong email, different later subject, inactive owner and
reapplication are refused. This does not exercise real Access JWT or external provider accounts.
Native D1 --file with an intentionally invalid final statement rolled back: stores0/admins0.
Native reapplication refused while preserving stores1/admins1. Existing store/admin/customer tests
preserve original records. The documented shell block refuses existing config/state before package
operations or copying; regression tests execute that block with a safe package-manager stub.

## Checks and review
Focused17 PASS; typecheck PASS; Knip PASS (existing CSS configuration hint); admin build PASS;
Wrangler dry-run PASS; git diff --check PASS. GitNexus has no registered public-source index, so
actual diff, SQL consumers and focused/native evidence were used instead.
Independent security/correctness review found no bootstrap/auth blocker. Documentation findings
about shell failure stopping and fixed queue names were adopted and checked.
Independent completed-task verification: T001–T009 all VERIFIED, zero flagged; T010 records that completed verification.
Public CI/security/Sonar remain required before merge and are tracked by the delivery work state.

## Evidence and limits
Reproducible commands: quickstart.md and docs/INSTALL.md. Raw command logs, native result JSON and
screenshots are under ignored output/oss-onboarding and are retained outside the temporary tree at
closeout. No real provider credentials or customer data were used. Real Access/LINE/Google/Turnstile/
Email booking and notification checks remain the installing operator's explicit readiness steps.

## PR review clarifications
Documented an explicit Calendar-ID update/readback, native resource creation and deployment
commands, and the fixed queue-name constraint. CLI flags were checked with installed Wrangler
--help. Initial data precedes first deployment; an already-warmed catalog follows the existing
60-second TTL-only contract. No runtime cache policy changed. The fixture now books an actually
advertised slot and compares the reservation start/end against it. Updated focused17/typecheck
PASS. Independent task verification was performed once before this review clarification.
