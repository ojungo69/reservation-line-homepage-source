# Maintenance tasks

Canonical progress is tracked in work_state system-improvement-20261117; these are the versioned verification requirements.

- [X] T001 Verify source/private baselines, preserve existing checkout changes. Evidence: specs/004-system-improvement/plan.md.
- [X] T002 Diagnose and set explicit admin favicon in admin-app/index.html and admin-app/public/favicon.svg.
- [X] T003 Match theme action label and next state in Header, regression all three states. Implementation: admin-app/src/components/header.tsx and admin-app/src/components/header.test.tsx.
- [X] T004 Keep LINE friend list/dialog results current through debounce, refetch, errors and truncation; delayed-response regressions. Implementation: admin-app/src/hooks/use-line-friends.ts and related pages/dialogs.
- [X] T005 Correct safe mutable Sonar findings without weakening rules or contracts; document necessary remaining duplication and historical findings. Evidence: reviewed application candidate d0fe863, successful public PR35 Sonar analysis (2026-11-16 UTC); serial claim operations and the hidden CSS invariant remain intentional.
- [X] T006 Prevent duplicate-consent and inactive-catalog races at booking write, preserve reason input boundaries and existing cap/error behavior. Implementation: src/reservations/public-submit.ts, src/admin/reservation-create.ts, src/reservations/slot-times.ts and src/routes/admin-api.ts.
- [X] T007 Revalidate reminder freshness, enforce dispatch quota and ordering across concurrent senders; preserve ambiguous delivery safety. Implementation: src/line/notifications.ts and test/line-notifications-consistency.test.ts.
- [X] T008 Serialize Google imports per calendar, reconcile busy-to-transparent changes, fail closed on malformed collections and preserve query generation with additive0059. Implementation: src/google/import-sync.ts, src/google/import-claim.ts, migrations/0059_google_calendar_sync_query_version.sql.
- [X] T009 Close conflict monitor timing gaps and verify stable token caching when safe. Implementation: src/google/conflict-burst-detector.ts and src/outbound-timeout.ts.
- [X] T010 Finish scoped whole-project audit manifests and deliver UI/AI/agent proposals; owner-only decisions explicit. Scope evidence: specs/004-system-improvement/research.md.


- [X] T013 Link new all-day-approved closures to mirror blocks with additive0060 and atomically cancel both directions; preserve legacyNULL rows and references. Implementation: src/admin/conflict-resolutions.ts and migrations/0060_all_day_closure_block_link.sql.
- [X] T014 Render missing hours as unconfigured/closed in API and admin, preserve configured stores and explicit closed days. Implementation: src/admin/settings-business-hours.ts and admin-app/src/components/settings/business-hours-tab.tsx.

- [X] T011 Integrate normal changes, mandatory checks, two-axis review and verify task evidence once. Evidence: d0fe863 local backend187/4096, admin88/951, Worker5/35; CI43915848707 and exact Sonar43916857898 successful; Standards/Spec mandatory findings0/0 and independent completion checks11/11.
- [ ] T012 Public PR/CI/Sonar then fixed-SHA private adoption, staging, exact-SHA production promotion and live smoke.
- [X] T015 Preserve watch renewal token/query-version provenance without promoting legacy tokens; verify first-channel and failed-stop behavior through SQLite watch-to-import regressions. Implementation: src/google/channel-watch.ts and test/google-calendar-watch.test.ts. Evidence: regression failed before the fix (unnecessary fullSyncQueued=1), passed afterward; 6 focused Google suites/195 tests, backend typecheck and Worker5/35 passed (2026-11-17). Required before T012 adoption.
Minimo preparation uses its existing independent contract; no Minimo code/flags/secrets/migrations enter this release. T005/T006/T007/T008/T009 are independent writers before T011. T012 depends on all release checks.
