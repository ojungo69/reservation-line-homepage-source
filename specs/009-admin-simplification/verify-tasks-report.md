# Verify Tasks Report: 009-admin-simplification (PR A)

- Date: 2026-11-20
- Scope: `branch` (`git diff origin/main...HEAD`, branch `009-admin-simplification`, 6 commits ahead of origin/main, 40 files changed)
- Completed tasks checked: 31 (all `[X]` in `specs/009-admin-simplification/tasks.md`)
- Method: `speckit-verify-tasks` five layers (file existence, diff cross-reference, content match, dead-code check, semantic assessment). Interactive walkthrough and extension hooks skipped by instruction. No tests, builds or installers were run.

> FRESH SESSION ADVISORY: this verification ran in a separate agent session from the one that implemented the tasks.

## Scorecard

| Verdict | Count |
|---|---|
| VERIFIED | 30 |
| PARTIAL | 0 |
| WEAK | 0 |
| NOT_FOUND | 0 |
| SKIPPED | 1 (T001) |

## Flagged items

None. Limits of this check (not flags):

- Red-before-green ordering (T002, T005, T009 to T013 and similar) cannot be confirmed from a static read. The test and implementation of each group land in the same commit, so the "see it fail first" step is not provable here.
- No test was executed. Verdicts rest on reading test bodies and implementation, not on a green run.
- T011 keeps `resourceName` in its fixture on purpose (commented: stale callers still pass it). The type no longer has the field; it passes only because the fixture is a variable, not an object literal. Harmless.
- T003 asks for a 1 to 2 line header rule. The header comment is 3 lines. Cosmetic.

## Verified items

| Task | Verdict | Evidence summary |
|---|---|---|
| T001 | SKIPPED | Baseline run, no artifact. Nothing in the diff contradicts it. |
| T002 | VERIFIED | `admin-app/src/lib/store-resources.test.ts` (new). Cases for unknown / none / single / multiple and for `resolveCreateTarget` (sole store, two stores, `settings` null, 0 resources, store switch, undecided store) all present. |
| T003 | VERIFIED | `admin-app/src/lib/store-resources.ts`: `StoreResources` (4 kinds, all with `resourceId`), `resolveStoreResources`, `resolveCreateTarget`, both notice constants with the exact required wording, header comment on the success-only `resources` rule. Used by create panel, detail panel, block dialog, recurring tab. |
| T004 | VERIFIED | `reservation-origin.test.ts` adds `DEFAULT_CREATE_ORIGIN` is `walk_in` and is in `RESERVATION_ORIGIN_OPTIONS`. Existing tests untouched. |
| T005 | VERIFIED | `reservation-create-panel.test.tsx`: FR-001 to FR-007 tests present (new describe block, fixtures per settings case). Existing `it.each` moves "店舗"/"リソース" to the two-store / two-resource fixtures. No-store guidance test uses two stores. `origin: "walk_in"` added to the expected payload. |
| T006 | VERIFIED | `admin-app/src/pages/schedule.test.tsx`: F5 test now asserts no "リソース" combobox and submits with `storeId: "store-2"`, `resourceId: "resource-2"`. |
| T007 | VERIFIED | `reservation-origin.ts` exports `DEFAULT_CREATE_ORIGIN: CreateReservationOrigin = "walk_in"`. Used at 3 sites in the create panel. |
| T008 | VERIFIED | `reservation-create-panel.tsx` derives `target = resolveCreateTarget(...)` and uses it for validation, submit payload, slot fetch, menu filter, confirmation. Store field hidden when `soleStore`, resource field only when `multiple`, `role="status"` notice on `none`, submit disabled on `saveBlocked`. "担当：" and slot-group heading gated on `multiple`. Dirty check compares raw `storeId`/`resourceId` and uses `DEFAULT_CREATE_ORIGIN`. Store-change reset retained. |
| T009 | VERIFIED | `reservation-detail-panel.test.tsx`: staff sees customer memo and allergy/notes values (`privileged = false`). Detail panel's memo section untouched in the diff. |
| T010 | VERIFIED | Same file mocks `use-settings`. Resource-row cases (1 slot hidden, loading hidden, 2 slots shown, inactive slot shown, fetch failure shown), button names for confirmed/pending_approval and none for completed, no "来店履歴" heading, no-show correction and revert-to-completed confirmation texts all present. |
| T011 | VERIFIED | New `reservation-reschedule-dialog.test.tsx`: heading "開始時刻を変更", button "この開始時刻に変更", description text without 担当 and heading "空き枠". |
| T012 | VERIFIED | `reservation-duration-dialog.test.tsx`: heading/description assertions added, 3 old button clicks changed to "この長さに変更", `resourceName` removed from the fixture. |
| T013 | VERIFIED | `use-reservations.test.tsx` expectations now "開始時刻を変更しました" / "長さを変更しました". |
| T014 | VERIFIED | `reservation-detail-panel.tsx`: `useShowResourceRow` (hidden when loading, or `single` and same resource; shown on fetch failure), buttons renamed, `resourceName` no longer passed to dialogs, "来店履歴" section and `visitStatusLabel` import removed, both confirmation texts reworded. Memo/allergy section unchanged. |
| T015 | VERIFIED | `reservation-reschedule-dialog.tsx`: `resourceName` removed from the type (`resourceId` kept), title, description, "空き枠" heading and submit label all as specified. |
| T016 | VERIFIED | `reservation-duration-dialog.tsx`: `resourceName` removed, title "長さを変更", description and submit label as specified. Field label and "現在の施術時間" unchanged. |
| T017 | VERIFIED | `use-reservations.ts` success toast now "長さを変更しました" / "開始時刻を変更しました". API paths and error texts unchanged in the diff. |
| T022 | VERIFIED | `use-settings-hooks.test.tsx`: `isLoaded` true after success, false while loading and after failure. |
| T023 | VERIFIED | New `external-block-create-dialog.test.tsx`: 1 / 0 / 2 resource cases and fetch failure case present. |
| T024 | VERIFIED | `recurring-blocks-tab.test.ts`: `kind` is the 7th argument, existing cases use `multiple`, `none` returns the notice even with other inputs valid and with no days selected. |
| T025 | VERIFIED | New `recurring-blocks-tab.form.test.tsx`: 1 resource (preview to create sends that resource), 0 (notice, preview disabled), 2 (field shown), plus idempotency key regenerated after load (and a loading case). |
| T026 | VERIFIED | `closures-tab.test.tsx`: follow on start-date pick, no follow after manual end-date edit, reset on reopen, no follow in edit mode, single-day save. |
| T027 | VERIFIED | `settings-regressions.test.tsx`: sets resources per case and awaits the field with `findByRole` for the two-resource case. |
| T028 | VERIFIED | `use-resources.ts` `useResourceList` returns `isLoaded: query.data !== undefined`. Consumed by the block dialog and recurring tab. |
| T029 | VERIFIED | `external-block-create-dialog.tsx`: uses `resolveStoreResources(isLoaded ? resourceList : undefined, ...)`, field only on `multiple`, derived `resourceId` for submit and `canSubmit`, notice on `none`, description text updated. |
| T030 | VERIFIED | `recurring-blocks-tab.tsx`: derived `resourceId` used in preview validation, preview-reset deps, idempotency-key effect deps and submit payload. Field only on `multiple`. `derivePreviewInvalid` returns the notice for `none` first. Rendered through `FormHint`. |
| T031 | VERIFIED | `closures-tab.tsx`: `endsAtTouched` state; start-date change follows only in add mode and while untouched; reset clears it; edit mode unchanged. |
| T047 | VERIFIED | `settings-tabs-status.test.tsx`: resource list has no "削除" and shows "無効化"/"有効化"; the delete-confirm test is closures-only. `useResourceDelete` mock removed. `use-settings-hooks.test.tsx`: `useResourceDelete` case and import removed. |
| T051 | VERIFIED | `resources-tab.tsx`: delete button, confirm dialog, state and imports removed. `useResourceDelete` removed from `use-resources.ts`. No remaining reference in `admin-app/src`. Server DELETE route untouched. |
| T052 | VERIFIED | The 4 files carry corrected comments. The claims (delete only sets `active = 0`, future reservations refuse) match `src/admin/settings-resources.ts` (`has_future_reservations` guard, `SET active = 0`). |
| T059 | VERIFIED | `specs/008-admin-calendar-ux/tasks.md` gains one line under T005: "2026-11-20（後半の PR）: 詳細の小窓の操作の名前は、spec 009 …". |

## Machine-parseable verdict lines

| T001 | SKIPPED | baseline run, no artifact |
| T002 | VERIFIED | resolver tests complete |
| T003 | VERIFIED | resolver implemented and wired |
| T004 | VERIFIED | default origin test |
| T005 | VERIFIED | create panel FR-001 to FR-007 tests |
| T006 | VERIFIED | schedule page F5 test updated |
| T007 | VERIFIED | DEFAULT_CREATE_ORIGIN exported and used |
| T008 | VERIFIED | create panel uses derived target |
| T009 | VERIFIED | staff memo/allergy test |
| T010 | VERIFIED | detail panel FR-008/010/012 tests |
| T011 | VERIFIED | reschedule dialog test |
| T012 | VERIFIED | duration dialog test |
| T013 | VERIFIED | toast expectations |
| T014 | VERIFIED | detail panel changes |
| T015 | VERIFIED | reschedule dialog changes |
| T016 | VERIFIED | duration dialog changes |
| T017 | VERIFIED | toast text |
| T022 | VERIFIED | isLoaded tests |
| T023 | VERIFIED | block dialog tests |
| T024 | VERIFIED | derivePreviewInvalid tests |
| T025 | VERIFIED | recurring tab form tests |
| T026 | VERIFIED | closures follow tests |
| T027 | VERIFIED | regression test updated |
| T028 | VERIFIED | isLoaded added |
| T029 | VERIFIED | block dialog implemented |
| T030 | VERIFIED | recurring tab implemented |
| T031 | VERIFIED | closures follow implemented |
| T047 | VERIFIED | resource delete tests changed |
| T051 | VERIFIED | resource delete UI/hook removed |
| T052 | VERIFIED | comments corrected, match server code |
| T059 | VERIFIED | 008 tasks line added |

## Unassessable items (SKIPPED)

| Task | Reason |
|---|---|
| T001 | Baseline test run with no artifact. Nothing in the diff contradicts it. |
