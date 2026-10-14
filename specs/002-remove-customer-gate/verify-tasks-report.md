# Verify-Tasks Report: 002-remove-customer-gate

> ⚠️ **FRESH SESSION ADVISORY**: For maximum reliability, run `/speckit.verify-tasks`
> in a **separate** agent session from the one that performed `/speckit.implement`.
> The implementing agent's context biases it toward confirming its own work.
> (This run was performed by a fresh verifier session with no stake in the implementation.)

- **Date**: 2026-10-14
- **Worktree**: `/home/jura/projects/rlh-source-wt-remove-gate` (branch `feat/remove-customer-gate-20261014`)
- **Scope**: `all` — base `d2307b0`..HEAD (`90a06f5`, `97a132f`, `1b6c168`) plus uncommitted/untracked changes (none present)
- **Tasks verified**: 10 (T001–T009, T013; T010–T012 are unchecked and out of scope)
- **Extension hooks**: none run (not requested)
- **Walkthrough**: skipped by caller instruction (caller handles flagged items)

## Summary Scorecard

| Verdict | Count |
|---|---|
| ✅ VERIFIED | 10 |
| 🔍 PARTIAL | 0 |
| ⚠️ WEAK | 0 |
| ❌ NOT_FOUND | 0 |
| ⏭️ SKIPPED | 0 |

## Evidence collected (shared by all tasks)

- **Leftover search** (`grep -rn`, all text/source types, excluding `node_modules`, `.git`, `dist`, `graphify-out`, `.gitnexus`, `.codegraph`, `specs/`):
  `customer[-_]gate|customerGate|CustomerGate|assertCustomerTabGate|CUSTOMER_GATE|grantCustomerTabGate|gateGranted|redactMemo|dropDisabledGrants|gate_email_failed|owner_email_unset|not_applicable|invalid_code|admin_customer_gate|tab.?gate|use-customer-gate|customer-gate-card`.
  Remaining hits are only:
  - `migrations/0053_admin_customer_gate.sql` (immutable migration, allowed) and a comment in `migrations/0055_drop_customer_email_columns.sql` (allowed: migrations/).
  - The three kept historical labels in `admin-app/src/lib/audit-format.ts:20-22` and their assertions in `admin-app/src/lib/audit-format.test.ts:120-128` (allowed).
  - `test/admin-customer-staff-access.test.ts:202-204` (the new test that asserts the removed endpoints return not-found; intended).
  - `test/line-notifications-owner.test.ts:740,757` — `job_owner_email_unset` is an unrelated notification-job fixture id, not the removed error code.
- **Deleted files confirmed absent**: `src/admin/customer-gate.ts`, `test/admin-customer-gate.test.ts`, `admin-app/src/components/customers/customer-gate-card.tsx`, `admin-app/src/hooks/use-customer-gate.ts`, `admin-app/src/components/customers/customer-chart-gate.test.tsx`, `admin-app/src/components/schedule/reservation-detail-gate.test.tsx`.
- **Tests run in the worktree** (read-only; no files changed — `git status --porcelain` empty before and after):
  - Backend: 11 files / 440 tests passed (`test/admin-customer-staff-access.test.ts`, `admin-staff-customer-scope`, `admin-operations`, `admin-customer-chart`, `admin-customer-actions`, `admin-customer-consents`, `admin-remaining-write-authorization`, `settings-staff-self-deactivation`, `settings-store-login`, `operations-email`, `admin-authz-matrix-sync`).
  - Admin SPA: 4 files / 115 tests passed (`reservation-detail-panel.test.tsx`, `pages/customers.test.tsx`, `lib/audit-format.test.ts`, `components/customers/*`).
  - Typecheck: root `tsc --noEmit` RC=0; `admin-app` `tsc --noEmit -p tsconfig.app.json` RC=0.
- **Red-first check for T002**: the base commit `d2307b0` was extracted with `git archive` into the session scratchpad (no checkout of this worktree), the new test file was copied in and run: 46/46 tests failed, and the inspected failures are gate-caused — `403 customer_gate_required` where `200`/`forbidden` was expected, the `customer-gate/request` route answering `200 {challengeId…}` and `/verify` answering `400 invalid_code` instead of `404 not_found`. The scratch copy was deleted afterwards.

## Flagged Items

None.

## Verified Items

### T001 — ✅ VERIFIED
| Layer | Result | Evidence |
|---|---|---|
| 1 File existence | positive | `spec.md`, `plan.md`, `research.md`, `data-model.md`, `quickstart.md`, `contracts/admin-api.md`, `checklists/requirements.md` all present |
| 2 Git diff | positive | all added in `90a06f5`/`97a132f` |
| 3 Content | positive | research.md has Decisions + removal inventory; contracts/admin-api.md has Removed/Changed/list-view sections; quickstart.md has validation and leftover search |
| 4 Dead code | not_applicable | docs |
| 5 Semantic | positive | ⚠️ Interpretive: decisions, inventory, contracts and validation are all recorded |

### T002 — ✅ VERIFIED
| Layer | Result | Evidence |
|---|---|---|
| 1 File existence | positive | `test/admin-customer-staff-access.test.ts` |
| 2 Git diff | positive | added (+266) in `1b6c168` |
| 3 Content | positive | matrix covers all 12 per-customer routes in the contract (GET detail/visits/reservations/consents, block/unblock/archive/unarchive, memo, referrer, profile, visit notes) × {own-store 200, other-store 403 forbidden, storeless 403 forbidden}; `?mode=list`, `?mode=list&view=archived`, `?q=` own-store-only + storeless 403; `memo` asserted for search; `POST /customers` own-store + storeless 403; `customer-gate/request` and `/verify` → `404 {error:"not_found"}` with no email sent |
| 4 Dead code | not_applicable | test file |
| 5 Semantic | positive | ⚠️ Interpretive: passes on HEAD; verifier re-ran it against base `d2307b0` and all 46 cases failed for gate reasons (`customer_gate_required`, live gate routes), so the red-first requirement holds. The red run is not recorded in git or `verification.md` (T010 still open), which the caller may want to record |

### T003 — ✅ VERIFIED
| Layer | Result | Evidence |
|---|---|---|
| 1 File existence | positive | `src/admin/customer-gate.ts` deleted as required; `shared.ts`, `admin-api.ts`, `customers.ts`, `admin-error-codes.ts` present |
| 2 Git diff | positive | all five files changed (customer-gate.ts −317) |
| 3 Content | positive | removed: `hasActiveCustomerGateGrant` import, `CUSTOMER_GATE_REQUIRED_BODY`, `assertCustomerTabGate` (shared.ts); gate imports, both `/customer-gate/*` routes, every `assertCustomerTabGate` call (detail, visits, reservations, consents, block, archive, `prepareCustomerMutation`, visit notes, `POST /customers`), `gateGranted`, `redactMemo` (admin-api.ts); `redactMemo` option, `memo: r.memo` returned as stored (customers.ts); the five codes `customer_gate_required`, `gate_email_failed`, `invalid_code`, `not_applicable`, `owner_email_unset` (admin-error-codes.ts) |
| 4 Dead code | positive | zero remaining references outside migrations/kept labels (leftover search) |
| 5 Semantic | positive | ⚠️ Interpretive: remaining staff protection checked at each former site — `staffHasStore` on `GET /customers`, `assertStaffCustomerStoreScope` on visit notes and in `prepareCustomerMutation`, `staffMayActOnCustomer` in `customer-actions.ts:207,456` for block/archive; T002 matrix proves out-of-scope refusal |

### T004 — ✅ VERIFIED
| Layer | Result | Evidence |
|---|---|---|
| 1 File existence | positive | `src/admin/settings-staff.ts`, `src/admin/settings-store-login.ts` |
| 2 Git diff | positive | −16 and −42/+… respectively |
| 3 Content | positive | approval-row `DELETE FROM admin_customer_gate_challenges` removed from the role/active batch; `dropDisabledGrants` and the Case A/B/C DELETEs removed; `disabledRows` still used by `emailWrite` |
| 4 Dead code | positive | no `admin_customer_gate` or `dropDisabledGrants` reference anywhere in src/test |
| 5 Semantic | positive | ⚠️ Interpretive: remaining batch writes (role UPDATE, deactivate UPDATE, email writes) intact; `settings-staff-self-deactivation` and `settings-store-login` tests pass |

### T005 — ✅ VERIFIED
| Layer | Result | Evidence |
|---|---|---|
| 1 File existence | positive | `test/admin-customer-gate.test.ts` deleted; all 10 edited files present |
| 2 Git diff | positive | all 11 files in the diff |
| 3 Content | positive | `grantCustomerTabGate` gone from `test/helpers/admin-access.ts`; no gate request/verify entries in `admin-remaining-write-authorization.test.ts`; grant-cleanup tests gone from settings tests; `operations-email.test.ts:24` comment now lists only 日次サマリー・LINE 枠アラート |
| 4 Dead code | not_applicable | test files |
| 5 Semantic | positive | ⚠️ Interpretive: 440 backend tests pass with no grant setup |

### T006 — ✅ VERIFIED
| Layer | Result | Evidence |
|---|---|---|
| 1 File existence | positive | card and hook deleted; 5 edited files present |
| 2 Git diff | positive | all 7 paths changed |
| 3 Content | positive | `CustomerGateCard`, `isCustomerGateRequired`, `gateRequired`/`gateBlocked`/`notesGate*`, `suspended` prop removed from customers.tsx, customer-detail-panel.tsx, reservation-detail-panel.tsx; `refetchInterval: 5 * 60_000` removed from use-customers.ts; four gate codes removed from `ApiErrorCode` and `ERROR_MESSAGES` |
| 4 Dead code | positive | no `customer-gate`, `suspended`, or `refetchInterval` references remain in those files; admin-app typecheck passes |
| 5 Semantic | positive | ⚠️ Interpretive: notes save now gated only by `notesConflict`/saving state; dialogs no longer depend on gate state |

### T007 — ✅ VERIFIED
| Layer | Result | Evidence |
|---|---|---|
| 1 File existence | positive | both gate test files deleted; two edited tests present |
| 2 Git diff | positive | all four paths changed |
| 3 Content | positive | `reservation-detail-panel.test.tsx` "スタッフは承認カードなしで施術メモを編集・保存できる" asserts no card, Save enabled, `saveNotes` called with expected payload, and post-save display; `customers.test.tsx` "スタッフはコード入力なしで顧客一覧を開く" |
| 4 Dead code | not_applicable | test files |
| 5 Semantic | positive | ⚠️ Interpretive: 115 SPA tests pass |

### T008 — ✅ VERIFIED
| Layer | Result | Evidence |
|---|---|---|
| 1 File existence | positive | `admin-app/src/lib/audit-format.ts`, `audit-format.test.ts` |
| 2 Git diff | positive | both changed |
| 3 Content | positive | three labels retained (lines 20-22); comment reworded to "2026-10-14 に撤去した…過去の監査行を…保持"; describe title "2026-10-14 に撤去した顧客タブ承認コードの履歴用監査ラベル" with all three assertions kept |
| 4 Dead code | positive | `ACTION_LABELS` consumed by `formatAuditSummary` |
| 5 Semantic | positive | ⚠️ Interpretive: history wording, assertions unchanged |

### T009 — ✅ VERIFIED
| Layer | Result | Evidence |
|---|---|---|
| 1 File existence | positive | `docs/admin-authz-matrix.md` |
| 2 Git diff | positive | changed (46 lines) |
| 3 Content | positive | both `customer-gate/*` rows removed; every "承認要" prefix removed from customer rows; dated note "2026-10-14: 顧客タブのオーナー承認コードを撤去…" added; earlier notes kept and suffixed "(2026-10-14 撤去)" |
| 4 Dead code | not_applicable | docs |
| 5 Semantic | positive | ⚠️ Interpretive: `admin-authz-matrix-sync.test.ts` passes. Minor: the `POST /api/admin/store-logins` row (line 154) still describes the Case B grant drop in the present tense, with only a trailing "(2026-10-14 撤去)". This is history wording, not a gap |

### T013 — ✅ VERIFIED
| Layer | Result | Evidence |
|---|---|---|
| 1 File existence | positive | `src/admin/customers.ts`, `src/routes/admin-api.ts`, `admin-app/src/lib/audit-format.ts`, `test/admin-customer-staff-access.test.ts`, `admin-app/src/lib/audit-format.test.ts`, `docs/admin-authz-matrix.md` |
| 2 Git diff | positive | all changed |
| 3 Content | positive | `export const recordStaffCustomerListView` at `customers.ts:283`: `INSERT OR IGNORE INTO audit_logs` with id `customer_list_view:<admin id>:<JST date>`, actor_type `staff`, action `customer.list_view`, target `admin_user`/admin id, metadata `{adminStoreId}`; try/catch → `safeCaptureException`. Label `"customer.list_view": "顧客一覧を表示"` at `audit-format.ts:23`; matrix row documents it |
| 4 Dead code | positive | imported at `admin-api.ts:203`; called at `admin-api.ts:1257` as `if (isStaff) await recordStaffCustomerListView(db, admin);` inside the `mode === "list"` branch only (after `listAllCustomers`, before return); `?q=` branch does not call it |
| 5 Semantic | positive | ⚠️ Interpretive: `audit_logs` schema (`0001_initial.sql:508`) has `id TEXT PRIMARY KEY` and allows `actor_type='staff'`, so `INSERT OR IGNORE` dedups per day. Tests cover: one row across list/offset/archived plus no row for `?q=`; correct actor/target/metadata; JST day rollover (14:59Z → 15:01Z gives a new row); owner not recorded; list still returned when `audit_logs` is dropped. SPA label test "customer.list_view を日本語で表示する" |

## Unassessable Items

None.

## Machine-parseable verdicts

| Task | Verdict | Summary |
|---|---|---|
| T001 | ✅ VERIFIED | Spec artifacts (spec, plan, research, data-model, quickstart, contracts, checklist) present with decisions, inventory, contracts and validation |
| T002 | ✅ VERIFIED | Route-matrix test covers every contract route; passes on HEAD; verifier confirmed 46/46 gate-caused failures on base d2307b0 |
| T003 | ✅ VERIFIED | Backend gate module, routes, calls, redactMemo and 5 error codes removed; store-scope checks remain at every former site |
| T004 | ✅ VERIFIED | Approval-row DELETEs and dropDisabledGrants removed from settings-staff and settings-store-login; tests pass |
| T005 | ✅ VERIFIED | Gate test deleted, grant helper and grant setup removed across listed tests, owner-mail comment updated; 440 tests pass |
| T006 | ✅ VERIFIED | SPA card/hook deleted; gate state, suspended prop, 5-min poll and 4 error codes removed; typecheck passes |
| T007 | ✅ VERIFIED | Gate SPA tests deleted; staff edits and saves treatment memo without card; customer list opens without code |
| T008 | ✅ VERIFIED | Three historical labels and assertions kept; comment and test titles reworded as history |
| T009 | ✅ VERIFIED | Matrix: two routes and 承認要 prefixes removed, dated 2026-10-14 removal note added |
| T013 | ✅ VERIFIED | recordStaffCustomerListView defined, called only for staff in GET /customers list branch, labeled, tested (dedup, day rollover, owner skip, failure tolerance), documented |
