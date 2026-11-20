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

## PR B (009-admin-simplification-b)

- Date: 2026-11-20
- Scope: `branch` (`git diff --name-only origin/main...HEAD`, branch `009-admin-simplification-b`, 12 commits ahead of origin/main, 32 files changed; plus uncommitted `specs/009-admin-simplification/tasks.md`, which only carries the `[X]` marks)
- Completed tasks checked: 28 (T018 T019 T020 T021 T032 T033 T034 T035 T036 T037 T038 T039 T040 T041 T042 T043 T044 T045 T046 T048 T049 T050 T053 T054 T055 T056 T057 T058)
- Method: `speckit-verify-tasks` five layers (file existence, diff cross-reference, content match, dead-code grep under `admin-app/src` and `src`, semantic read). Interactive walkthrough and extension hooks skipped by instruction. Read-only: for T056/T057 evidence only, the touched test files were run (13 admin-app files, 211 tests green; `test/admin-reservations-period.test.ts` and `test/design-tokens-parity.test.ts`, 65 tests green), plus `tsc --noEmit` (root), `tsc -b --noEmit` (admin-app), `knip` and `git diff --check`, all clean. No file other than this report was changed.

> FRESH SESSION ADVISORY: this verification ran in a separate agent session from the one that implemented the tasks.

### Scorecard

| Verdict | Count |
|---|---|
| VERIFIED | 25 |
| PARTIAL | 1 (T046) |
| WEAK | 0 |
| NOT_FOUND | 0 |
| SKIPPED | 2 (T057, T058) |

### Flagged items

#### T046 PARTIAL (semantic downgrade, minor, Interpretive)

Task: add a 1-line comment on `storeId` in the audit details of `src/admin/line-friends.ts` saying (a) it is the store the admin screen was showing when the link was made, (b) it is NOT the link destination (customers do not belong to a store), (c) it is sent for the existence check. Code and checks unchanged.

| Layer | Result | Evidence |
|---|---|---|
| 1 File existence | positive | `src/admin/line-friends.ts` exists |
| 2 Diff cross-reference | positive | file in branch diff, +1 line only |
| 3 Content match | positive | one comment line added above `storeId: input.request.storeId` (line 511) in the `JSON.stringify({...})` audit details; no code or validation change |
| 4 Dead-code | n/a | comment only |
| 5 Semantic | negative (Interpretive) | The comment reads "Selected store, or the first store when all are shown (not an owner's choice); used only for the existence check and this record." Points (a) and (c) are covered. Point (b) is only implied by "not an owner's choice": it never says the store is not the link destination, nor that customers do not belong to a store, which is the wording research.md:68-69 and tasks.md T046 ask for. The comment is also in English while tasks.md describes the content in Japanese (language is not specified by the task, so not counted). |

Evidence gap: `src/admin/line-friends.ts:511`. Fix is one clause, for example "not the link destination: customers belong to no store".

Limits of this check (not flags):

- Red-before-green ordering (T018, T019, T033 to T038, T048 to T050 "赤を確かめる") cannot be confirmed from a static read. For T050 the old code path (`archiveCsvToR2` plus `waitUntil`) visibly would call `put` and `waitUntil`, so the test would have been red on the old code.
- T044 goes beyond the task text: `src/pages/line-friends.tsx` adds a last-page clamp (`pastLastPage`, `invalidateQueries`, `setPage(totalPages)`) and `use-line-friends.ts` exposes `isPaused`. Both are covered by new tests in `line-friends-loading.test.tsx` (3 added tests). It is not a phantom and not a stub, but it is unplanned scope; the 009 spec does not list it.
- `LineFriendsFilter = "unlinked" | "linked" | "all"` (`admin-app/src/types/api.ts:572`) and the server's `filter` values (`src/admin/line-friends.ts:277,307`) still exist. This matches FR-024 (server values unchanged). The admin UI now only ever passes `"unlinked"` (`line-friends.tsx:37`). No UI reference to `"linked"`/`"all"` remains.
- `src/worker-configuration.d.ts` (generated) and `wrangler.jsonc` still declare `STORAGE` and `CSV_ARCHIVE_ENABLED`, as FR-023 requires. `test/admin-reservations-period.test.ts:818` passes both on purpose (leftover-config test).
- `test/design-tokens-parity.test.ts` loses the `line-friends.tsx` emerald allow-list entry, consistent with the removal of the "紐付け済み" label (T044). It is a test allow-list, not a deploy or inspection config.

### Verified items

| Task | Verdict | Evidence summary |
|---|---|---|
| T018 | VERIFIED | `reservation-list-card.test.tsx` (in diff): fixture still has `resourceName: "担当 佐藤"`; asserts card text contains "渋谷店", not "担当 佐藤", not " · ". |
| T019 | VERIFIED | `customer-detail-panel.test.tsx`: new test scopes to the card (`closest("div")` of "予約詳細を見る →" is the `ChartReservationCard` root div), expects "新宿店", no `/枠A/`. |
| T020 | VERIFIED | `reservation-list-card.tsx`: `& { resourceName?: string }` removed from the Pick type; renders store name only. Callers `schedule.tsx:440`, `calendar-v2/body.tsx:250`, `reservations.tsx:555` compile (tsc clean). |
| T021 | VERIFIED | `customer-detail-panel.tsx` `ChartReservationCard`: `{reservation.storeName}` only. No `resourceName` left in the file; API type `resourceName` kept (`types/api.ts:13,94,252`). |
| T032 | VERIFIED | `reservation-list-card.test.tsx`: `showStoreName={false}` hides store and resource names and the `<p>` itself (3 `<p>` left); default shows "渋谷店". |
| T033 | VERIFIED | `reservation-search-state.test.ts` "saved status filter": `__all__` and every offered status restored (incl. `confirmed`); `checked_in`, `unexpected`, empty string give `null`. |
| T034 | VERIFIED | `reservations.test.tsx`: FR-016 (5 vs 6 column headers, "店舗" option absent/present, card store name absent/present, saved `storeName` sort restores as 日時 descending, hidden-sort no-resurrect cases), FR-017 (no "来店中" option, saved `checked_in` falls back to default), `buildCsvExportUrl` mock removed (no reference left). |
| T035 | VERIFIED | `reservations-search.test.tsx`: two CSV-button disabled assertions deleted, third turned into `queryByRole("button", {name: "CSV"})` is null. |
| T036 | VERIFIED | New `link-store-id.test.ts`: [a,b] with b gives b; `null`/`undefined`/unknown gives a; 0 stores gives `""`. |
| T037 | VERIFIED | `line-friends.test.tsx`: no field/label/combobox/guidance with 2 stores and both link buttons enabled; storeId `store-2` when selected, `store-1` when `null`; three filter buttons absent and `useLineFriends` called with `filter: "unlinked"`; 0-store/pending cases kept (`hasStore` table). |
| T038 | VERIFIED | `link-line-from-card-dialog.test.tsx`: no field or guidance with 2 stores; posts first store when none selected and `store-2` when selected. |
| T039 | VERIFIED | `reservation-list-card.tsx` `showStoreName = true` default, store row omitted when false; used by `reservations.tsx:559`. |
| T040 | VERIFIED | `reservation-search-state.ts` exports `ALL_SENTINEL`, `RESERVATION_STATUSES` (no `checked_in`); `readReservationSearchState` rejects non-offered values via `isOfferedStatusFilter`; both exports consumed in `reservations.tsx`. |
| T041 | VERIFIED | `reservations.tsx`: statuses read from T040; `showStore = storeId === null` hides table header/cell, sort option, card store name; `effectiveSortKey` maps `storeName` to `startAt` (also for header indicators); `colSpan={5 + Number(showStore)}`; CSV button, `handleCsvDownload`, `csvError`, `isDownloading`, `useCallback` removed. `isDebouncing`, `errorMessage`, `Button` still used elsewhere. |
| T042 | VERIFIED | `buildCsvExportUrl` removed from `use-reservation-search.ts`; no reference in `admin-app/src` or `src`; `buildSearchParams` still used by the search hook. |
| T043 | VERIFIED | `link-store-id.ts` `pickLinkStoreId`: selected id if in list, else first, else `""`. Used by `line-friends.tsx:52` and `link-line-from-card-dialog.tsx:40`. |
| T044 | VERIFIED | `line-friends.tsx`: store field and guidance, filter buttons and state removed; store from `pickLinkStoreId`; pending/no-store disabling kept; always `filter: "unlinked"`; search box kept. Extra last-page clamp noted above. |
| T045 | VERIFIED | `link-line-from-card-dialog.tsx`: store select, state, guidance and the old comment removed; sends `pickLinkStoreId(stores, selectedStoreId)`. |
| T048 | VERIFIED | `customer-detail-panel.test.tsx`: no "アレルギー" text; "ナッツ類" appears once, inside the "注意事項" section; 生年月日, 性別 (女性), 紹介者 shown. |
| T049 | VERIFIED | `google-sync-view-model.test.ts` (`storeLabel`: known name, 8 chars plus "…", blank names) and `google-sync.test.tsx` ("店舗 新宿店 — …", "店舗 unknown-… — …"), fixed strings. |
| T050 | VERIFIED | `test/admin-reservations-period.test.ts:807`: env with `STORAGE: { put }` and `CSV_ARCHIVE_ENABLED: "true"`; asserts 200, content type, disposition, 3 CSV lines and header, `put` and `waitUntil` not called. |
| T053 | VERIFIED | `customer-detail-panel.tsx`: only the "アレルギー" `Row` removed; 生年月日/性別 rows and the 注意事項 section (`:829`) intact. |
| T054 | VERIFIED | `google-sync-view-model.ts` `storeLabel` (name, or first 8 chars + "…"; trims blank names); used in `buildGoogleSyncViewModel` and `google-sync.tsx:456`. |
| T055 | VERIFIED | `src/storage/r2-helpers.ts` and `test/r2-helpers.test.ts` gone (directory `src/storage` gone); `admin-api.ts` import and archive block removed, returns `new Response(rawStream, …)`; `STORAGE` and `CSV_ARCHIVE_ENABLED` removed from `src/bindings.ts`; `wrangler.jsonc` not in diff; `docs/INSTALL.md:61` now says the app writes no CSV archive. No `archiveCsvToR2` or `r2-helpers` reference remains. |
| T056 | VERIFIED | Process task. Greps over `admin-app/src`, `src`, `test`: no remaining `buildCsvExportUrl`, `archiveCsvToR2`, `r2-helpers`, `STORAGE` or `CSV_ARCHIVE_ENABLED` in app code (only generated `worker-configuration.d.ts`, `wrangler.jsonc`, the intentional T050 test, docs); no removed LINE friends filter literal in UI code. Root `tsc --noEmit`, admin `tsc -b --noEmit`, `knip` clean; `git diff --check` clean; branch diff names contain no `wrangler.jsonc`, workflow, `tsconfig*`, `vitest*` or package files. |

### Skipped items

| Task | Verdict | Reason |
|---|---|---|
| T057 | SKIPPED | The full CI-equivalent suite in plan.md "検証" (`cf:types`, `knip`, `test:unit --coverage`, `test:worker`, `.github/scripts`, `admin:build`, `coverage:admin`, `cf:check`, `audit:*`) leaves no artifact in the repo, and this session did not run all of it, so the implementer's run cannot be confirmed. Partial local evidence only: touched tests, both typechecks and knip pass. |
| T058 | SKIPPED | Local browser checks on the current and the new calendar (quickstart.md 2) are not verifiable from repo state. |

### Machine-parseable verdict lines

| T018 | ✅ VERIFIED | list card shows store only, test updated |
| T019 | ✅ VERIFIED | chart card store only, scoped test |
| T020 | ✅ VERIFIED | resourceName removed from card type |
| T021 | ✅ VERIFIED | chart reservation card store only |
| T032 | ✅ VERIFIED | showStoreName tests |
| T033 | ✅ VERIFIED | saved status filter restore tests |
| T034 | ✅ VERIFIED | reservations page FR-016/017 tests |
| T035 | ✅ VERIFIED | CSV button assertions removed |
| T036 | ✅ VERIFIED | pickLinkStoreId tests |
| T037 | ✅ VERIFIED | line friends FR-019/020 tests |
| T038 | ✅ VERIFIED | card link dialog tests |
| T039 | ✅ VERIFIED | showStoreName prop implemented |
| T040 | ✅ VERIFIED | status list moved, restore rejects unoffered |
| T041 | ✅ VERIFIED | reservations page store column, sort, CSV removed |
| T042 | ✅ VERIFIED | buildCsvExportUrl removed, no references |
| T043 | ✅ VERIFIED | pickLinkStoreId implemented and used |
| T044 | ✅ VERIFIED | line friends page simplified (plus unplanned last-page clamp) |
| T045 | ✅ VERIFIED | card link dialog simplified |
| T046 | ⚠️ PARTIAL | comment present but does not say store is not the link destination (line-friends.ts:511) |
| T048 | ✅ VERIFIED | allergy row absent, notes shown |
| T049 | ✅ VERIFIED | storeLabel tests, fixed strings |
| T050 | ✅ VERIFIED | leftover archive setting test |
| T053 | ✅ VERIFIED | allergy row removed |
| T054 | ✅ VERIFIED | storeLabel implemented and used |
| T055 | ✅ VERIFIED | archive code, helper and test removed |
| T056 | ✅ VERIFIED | no remaining references, tsc/knip/diff-check clean |
| T057 | ⏭️ SKIPPED | full CI-equivalent suite not observable |
| T058 | ⏭️ SKIPPED | browser checks not observable |

### Walkthrough Log (PR B)

The rows above are the verifier's record and are unchanged. Dispositions after the report:

| Task | Before | Disposition |
| --- | --- | --- |
| T046 | 🔍 PARTIAL | Fixed: the `storeId` comment in `src/admin/line-friends.ts` now names all three points of the task (the store the admin screen showed, not the link target because customers belong to no store, sent for the existence check). Comment only; no code change. |
| T057 | ⏭️ SKIPPED | Evidence from the implementing session: the CI-equivalent suite passed on the branch rebased onto main (cf:types, typecheck, knip, root unit tests 4322, worker tests 35, CI script tests, admin typecheck and build, admin coverage tests 1290, cf:check, both audits). The GitHub `validate` check runs on the pushed head. |
| T058 | ⏭️ SKIPPED | Evidence from the implementing session: the built admin app with stubbed admin APIs passed 33 of 33 browser checks with PR A and PR B combined, five of them on the new calendar (create panel for owner and staff, the no-resource notice, the detail panel, the staff detail). |

A clean re-run of `/speckit.verify-tasks` for T046 is suggested if the comment wording is to be re-scored.
