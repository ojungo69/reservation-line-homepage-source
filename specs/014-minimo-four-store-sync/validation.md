# Local source-port validation

Date: 2026-11-17 (Asia/Tokyo). Current base: `d0fe863572c3a1320f3f863eb1eafb84d2a9d5c6`. Earlier checkpoints below used `3cd583d8106c1d49a5795dc43f934c9e300526fd`; the latest-base results are recorded at the end.

Local verification and both independent review axes passed for the initial port. The closure-preserving migration delta uses Minimo 0061–0063 after application migrations 0059 and 0060. It is now integrated on the current normal application base, with fresh verification complete and independent review pending. Earlier reviews cover only the earlier packet. All provider calls in local tests are synthetic. No production DB migration, secret synchronization, provider availability write or booking mutation is part of this port.

Initial compatibility checks using the existing local dependency installation passed 423 focused tests across 17 files and 5 native D1/workerd tests across 2 files. Generated Worker types resolved the fresh-worktree type declarations, and typecheck passed. These initial checks used an older installed Wrangler than the committed lock; final checks below used clean root and admin `npm ci --ignore-scripts` installations.

| Check | Result |
| --- | --- |
| `npm run cf:types` and `npm run typecheck` | Passed with committed dependency lock; root Wrangler 4.158.0, Vitest 4.1.12 |
| `npm run test:unit` | First run: 187 files passed, 4064 tests passed, one missing-route documentation assertion failed and one CSS fixture suite could not load without admin dependencies |
| `npm run test:unit -- test/admin-authz-matrix-sync.test.ts test/design-tokens-parity.test.ts` | After adding both Minimo routes to the authorization matrix and installing admin dependencies: 2 files / 34 tests passed. Combined with the unchanged passing suites: 189 files / 4097 unique tests passed across the two runs |
| `npm run test:worker` | 7 files / 40 tests passed, including Minimo's native D1 migration/transaction and workerd transport tests |
| `npm run knip` | Passed after installing admin dependencies; existing configuration hints retained |
| `npm run admin:typecheck` and `npm run admin:build` | Passed; existing large-chunk warning retained |
| `npm run cf:check` | Dry-run passed, `MINIMO_SYNC_MODE=off`, no upload |
| `git diff --check` | Passed |

The Worker test plugin's existing nested Wrangler 4.124.0 emits an `observability.redact_query_string` warning. Its installed version matches the committed nested dependency; no configuration or gate was weakened to suppress it. Knip also notes the upstream Worker plugin rename. These are existing dependency maintenance items, not evidence of failed Minimo checks.

All ten `src/minimo/` modules and `src/admin/minimo-sync.ts` were reused without byte changes. Shared integration was adapted separately. Existing migration files through 0058 are unchanged. At the earlier combined checkpoint, new migrations and populated-upgrade fixtures used 0060–0062; the latest closure follow-up below moves them to 0061–0063. Private runtime/deployment tooling and operational account evidence were not copied into this source tree.

No commit, push, PR, CI/Sonar run, staging deployment or production activation was performed for this port. Earlier implementation checks or historical live-account evidence do not substitute for a future fixed-SHA review, provider preflight and deployment verification.

Independent Standards/security and Spec reviews found zero required findings across the original 47-file manifest. The later delta only renumbers new migrations to 0060–0062, their temporary table names and fixture/document references; runtime code remains unchanged. Earlier test counts above belong to the reviewed pre-renumbering snapshot.

## Earlier combined migration checkpoint

This earlier packet was the same application base plus the separate prerequisite `0059_google_calendar_sync_query_version.sql` (SHA-256 `a0305eb8340ca0da5f798796a41a5b0c68384cebe4e87ccad1dfb726e65d3d1a`) and Minimo migrations 0060–0062. The prerequisite is normal application work, not Minimo implementation. Only its SQL was copied; the concurrent application's runtime changes were excluded. That checkpoint had 48 files including one prerequisite. The latest closure follow-up has 49 files including two prerequisites.

- Minimo, operator recovery, public installation, source-route, cancellation and authorization fixtures: 17 files / 493 tests passed.
- Settings, common idempotency and existing migration/store-integrity guards: 12 files / 188 tests passed.
- Native Minimo D1/workerd: 2 files / 5 tests passed, including populated pre-0060 migration application followed by 0060–0062.
- An additional local SQLite assertion check applied 0001–0058, inserted synthetic channel/token, Google references, block and locks, then applied 0059–0062. It preserved all original row values (new columns only), the old sync token with null query provenance, indexes and triggers. Foreign-key violations: 0; integrity: `ok`; temporary migration tables: 0.
- All original 58 migration files remain byte-identical to the base. All eleven reused Minimo runtime files remain byte-identical to the reviewed implementation. `git diff --check` passed.

These combined checks do not replace a future fixed-SHA full CI run after integrating the normal application's runtime changes. No production migration, secret synchronization or deployment occurred.

## Closure-pairing compatibility follow-up

The later application prerequisite `0060_all_day_closure_block_link.sql` has SHA-256 `d4c0c60c5dc30edd3ae4e9d340d16a6ec339416e4ed12d92f89987dd97d2ae96` and is copied unchanged. The Minimo migrations are now 0061–0063. Existing 0001–0058, Google 0059 and closure 0060 bytes are unchanged. Runtime code remains unchanged; 0061 and its tests are a new migration delta requiring independent review.

- RED: the two populated SQLite closure cases, with recursive triggers 0/1, failed on the former parent-table DROP with a foreign-key error.
- GREEN: `npm run test:unit -- test/minimo-migration.test.ts` passed 28 tests. It checks exact closure rows/links/FK/index/trigger definitions, jobs/history/audits unchanged during migration, retained legacy null links, both cancellation directions and SQLite integrity/FK checks.
- `npm run test:unit -- test/minimo- test/admin-minimo-sync.test.ts test/publication-config.test.ts test/admin-settings- test/admin-external-blocks.test.ts test/admin-sync-recovery-atomic-external-block.test.ts` passed 23 files / 316 tests.
- `npm run test:unit -- test/admin-all-day-approval test/google-calendar-import.test.ts` passed 3 files / 141 tests. Typecheck passed.
- `npm run test:worker -- test/minimo-d1.worker.test.ts test/minimo-runtime.worker.test.ts` passed 2 files / 5 tests. The enhanced D1 case injects a duplicate saved-link failure immediately after `DROP TABLE external_blocks` and verifies full schema/data/migration-history rollback in both recursive modes using `applyD1Migrations`' own D1 batch, without a test-added transaction. Successful migration preserves all fixture records, closure FK/index/triggers and an unrelated closure trigger; paired cancellation and original Minimo import/stale-lease behavior still work.
- Actual installed Wrangler 4.158.0 `d1 migrations apply --local` applied 0001–0060, rolled back the same induced mid-0061 failure exactly, then applied 0061–0063 successfully without migration cancellation effects. Both cancellation directions worked afterward. The persisted local D1 SQLite file passed read-only `integrity_check` and `foreign_key_check`; D1 API itself rejects `integrity_check` with SQLITE_AUTH.

[Wrangler's official migration contract](https://developers.cloudflare.com/d1/wrangler-commands/#d1-migrations-apply) documents per-migration rollback on failure. Installed Wrangler builds one full migration command including its history row: local execution uses one `db.batch`, and remote execution sends one query body. The local CLI/native proofs support this implementation; no remote production failure was induced. Run the migration atomically through the supported migration command, not by executing its statements individually.

## Current normal-application base

The current feature tree starts at `d0fe863572c3a1320f3f863eb1eafb84d2a9d5c6`. The earlier feature's tracked patch was applied with Git's three-way merge from `3cd583d`, and new feature files were copied only where absent. Application migrations 0059/0060 are already tracked in this base and were not copied over or modified. The merge had no conflicts. All eleven Minimo runtime files and Minimo migrations 0061–0063 match the prepared feature. Current Google import changes remain intact except for the additional `minimo` source type; current claim fences, default fetcher, consent, hours and all-day implementations are retained.

Full current-base unit verification initially passed 197 files / 4238 tests, with one historical-upgrade fixture failing because it applied all migrations except its target 0060, including future 0061. Its selection now uses `name < migration`, so it constructs the intended pre-0060 schema. The corrected file passed all 11 tests. Combined without double-counting the ten tests that had already passed: 198 files / 4239 unique tests passed across the two runs.

The full Worker suite passed 7 files / 40 tests, including the enhanced native Minimo migration rollback/cancellation test. Worker type generation, backend/admin typecheck, Knip, admin build, Worker dry-run and `git diff --check` passed. Root/admin dependency manifests and locks match the previously clean-installed dependency tree used for verification. Existing Worker plugin/dependency and bundle-size warnings remain unchanged.

Commands:

```sh
npm run cf:types
npm run typecheck
npm run knip
npm run test:unit
npm run test:unit -- test/all-day-linked-cancellation.test.ts
npm run test:worker
npm run admin:typecheck
npm run admin:build
npm run cf:check
git diff --check
```

The feature delta now changes 48 files, including the one additional historical-fixture correction. The review manifest also records the two unchanged prerequisite migrations as context, for 50 entries total; they are not feature changes. Current-base integration and the closure migration still require independent review. No commit, push, PR, CI/Sonar or deployment is claimed for this feature.
