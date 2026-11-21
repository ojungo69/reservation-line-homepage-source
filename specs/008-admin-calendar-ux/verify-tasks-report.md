# speckit-verify-tasks report: T005 only

- Verified head SHA: `e3444c1a87e45b4b73277b7735265eb602eb3dd8` (as printed by `git rev-parse HEAD` on branch `008-t005-detail-create`)
- Date: 2026-11-21 (UTC, `date -u`)
- Scope: plan-anchored. `plan.md` is dated 2026-11-19. T005 was built in two PRs, and evidence from both counts:
  - first half: already on `origin/main` (commit `17bd0d4`, "spec 008 T005, first half", #60). Later T006 commits on main (`3665a22`, `ca03321`, `75abde9`) also touch the same files.
  - second half: this branch, `origin/main...HEAD` (6 commits, 15 files; `origin/main` is `75abde9fc8c8eaf2149590f3cada62ff8594bbbc`).
- Verifies T005 ONLY. Earlier reports (for example the T004b one) live in git history.
- Fresh session advisory: this run was made in a separate context from the implementing agent, as the skill recommends.
- Skipped on purpose: extension hooks (the worktree has no `.specify/`), and the interactive walkthrough (flagged items are listed below instead). `FEATURE_DIR` was set directly to `specs/008-admin-calendar-ux`.

## Test results (one file at a time, `--maxWorkers=1`, never the full suites)

| File | Result |
|---|---|
| `admin-app/src/pages/schedule-v2.test.tsx` | 145/145 passed |
| `admin-app/src/components/schedule/reservation-detail-panel.test.tsx` | 58/58 passed |
| `admin-app/src/components/calendar-v2/stable-anchor.test.tsx` | 4/4 passed |
| `admin-app/src/components/calendar-v2/columns.test.ts` | 11/11 passed |
| `admin-app/src/components/calendar-v2/event.test.ts` | 9/9 passed |
| `admin-app/src/components/calendar-v2/geometry.test.ts` | 22/22 passed |
| `admin-app/src/components/shell-v2/app-shell-v2.test.tsx` | 38/38 passed |
| `admin-app/src/components/shell-v2/sidebar-v2.test.tsx` | 12/12 passed |
| `test/admin-calendar-tokens.test.ts` (repo-root config) | 7/7 passed |

Not run: `tsc -b`, lint, the full suites, any mutation run, any browser run.

## Scorecard

| Verdict | Count |
|---|---|
| VERIFIED | 0 |
| PARTIAL | 1 (T005) |
| WEAK / NOT_FOUND / SKIPPED | 0 |

## Flagged item: T005 (PARTIAL)

Why PARTIAL and not VERIFIED: every mechanical layer is positive and the behavior is implemented in code, but one clause that says "確認する" has no pinning test, and two smaller behaviors in the second-half notes have no test either. Under the asymmetric error model these are flagged. None of them is a missing implementation.

| Layer | Result | Detail |
|---|---|---|
| 1 File existence | positive | `test/admin-calendar-tokens.test.ts`, `DESIGN.md`, `admin-app/src/pages/schedule-v2.tsx`, `components/calendar-v2/*`, `components/shell-v2/*`, `components/schedule/reservation-detail-panel.tsx`, `components/ui/popover.tsx` all exist. |
| 2 Git diff cross-reference | positive | Second half changes `schedule-v2.tsx`, `body.tsx`, `sidebar-parts.tsx`, `stable-anchor.ts`, `reservation-detail-panel.tsx`, `popover.tsx`, shell files and `use-media-query.ts`. First half is in `17bd0d4`. |
| 3 Content pattern matching | positive | The only backticked path in the task, `test/admin-calendar-tokens.test.ts`, holds the new adjacent-pair checks (`GRID_EDGES` against `gridBackdrops`, lines 136 to 161 and 177 to 184; `cal-alert` on `cal-surface` in `OPAQUE_PAIRS`). |
| 4 Dead-code detection | positive | `stableAnchor` (schedule-v2.tsx:25,151), `CalendarLayers` and `CreateReservationButton` (sidebar-parts.tsx, used at schedule-v2.tsx:356-357), `DetailFrame` (reservation-detail-panel.tsx:58, used at 410), `closeMenu` (schedule-v2.tsx:213), `sidebarSlots` (schedule-v2.tsx:356-357), `DOCKED_QUERY` (schedule-v2.tsx:94, app-shell-v2.tsx) are all referenced. |
| 5 Semantic assessment | positive with gaps | Interpretive: each clause below was matched to code. Gaps are in pinning tests only. |

### Flagged gaps (clause, what is missing, evidence)

1. Clause: "複数店舗、全店舗の日表示、**リソースごとの外部ブロック**、一部の取得失敗を確認する". Missing: a test that an external block on a different store or a different resource lands in the right column. Every block fixture in `admin-app/src/pages/schedule-v2.test.tsx` is on store `s1` and resource `r1` (fixture at lines 108-124; uses at 281, 282, 702, 1002, 2144). The code sorts blocks into columns by `block.storeId` only (`admin-app/src/components/calendar-v2/body.tsx:34-37`) and ignores `resourceId`, so a block on a stopped or second resource is expected to show in its store's column. That is the intended behavior, but nothing pins it, and the all-stores day test (schedule-v2.test.tsx:394-407) places no block in the `s2` or `s3` column.
2. Clause (second-half note): "詳細を閉じると選択も外れる" and the selected booking mark. Missing: a test that the pressed booking shows as selected while its detail is open and stops showing it after close. The code is there (`selected` gives a primary ring and `aria-expanded` at `admin-app/src/components/calendar-v2/event.tsx:111,142`; `selectedId` passed at `column.tsx:227`; `setSelectedReservationId(null)` at `schedule-v2.tsx:377`). No test mentions `aria-expanded`, the ring or `selectedId` (greps of `schedule-v2.test.tsx` and `calendar-v2/*.test.*` find none). The nearest test (`schedule-v2.test.tsx:496-505`) only checks that `onClose` makes the palette block false.
3. Clause: "表示の絞り込みと空き判定を分ける" (INT-06-02), Google half. Missing: a test that turning off 表示する予定 "Googleカレンダーの予定" leaves the slot count unchanged. Only the 承認待ち toggle is checked against slots (`schedule-v2.test.tsx:590-602`); the Google toggle test (604-612) checks only which blocks show. Code is correct: `columnState` (`body.tsx:96-123`) never reads `layers`.

### Items the tests mock around (interpretive, no gap claimed)

- `schedule-v2.test.tsx` replaces `ReservationDetailPanel` with a capture, so the page tests pin only the `layout` ("popover" or "bottom") and the anchor rect handed over (520-536, 657-665). The real container is pinned separately in `reservation-detail-panel.test.tsx:725-780` (opens as "予約詳細", modal so the calendar underneath is out of reach, close button, Esc and outside press all pass the unsaved-note guard, bottom sheet, default stays the right sheet). The two halves are not tested together with the real panel, including the hand-off from the 承認待ち sheet closing to the popover opening beside the 承認待ち button.
- Detail content, permissions and customer-info masking: the diff of `reservation-detail-panel.tsx` with whitespace ignored is only the new `DetailFrame` (container) plus `layout` and `anchor` props. The body is the existing component, so the "same permission and masking" clause holds by reuse. The existing detail tests (58 passed) cover the content.
- "ページ移動とは重ねて開かない": the page sets `setPaletteBlocked(sheetOpen)` (`schedule-v2.tsx:139-144`); the shell refuses to open page move while blocked (`app-shell-v2.tsx:72`); pinned by `schedule-v2.test.tsx:496-505` and `app-shell-v2.test.tsx:565` (Cmd/Ctrl+K and the bar button). The blur-count limit itself (DESIGN.md §3: at most 2 over the calendar, 3 with a detail) rests on the material choice (`popover.tsx:18`, `glass-modal`) and the tokens test, not on a count test.
- Not checked in a browser (walkthrough skipped): popover placement and edge collision, real blur cost, hit-testing of the bar over the grid, focus hand-off between sheets.
- Open owner item, not a code gap: "表示する予定は保存しない" is recorded as an implementer default awaiting owner confirmation (tasks.md T005 note, 2026-11-22). The code matches the note (plain `useState`, `schedule-v2.tsx:128`, no storage).

### Clause-by-clause map (task text to code to pinning test)

| Clause | Code | Pinning test | Status |
|---|---|---|---|
| Week and day on a shared time axis; 1 store per column; week for 1 store; overlaps side by side | `columns.ts`, `geometry.ts`, `column.tsx` | `schedule-v2.test.tsx:317-337`, `columns.test.ts`, `geometry.test.ts` | ok |
| All stores: day view with a column per store; week asks to pick a store | `columns.ts` `effectiveView`, `notices.tsx` `weekNeedsStore`, `schedule-v2.tsx:335` | `schedule-v2.test.tsx:394-407` | ok |
| One visible store is treated as selected; no all-stores wording or notice | `columns.ts` `visibleStoreId`, `store-switch-v2.tsx:25-27` | `schedule-v2.test.tsx:409-415`, `store-switch-v2.test.tsx:68-74` | ok |
| Staff fixed to their store | `store-switch-v2.tsx:27` | `store-switch-v2.test.tsx:39-66` | ok |
| Top bar (store switch, pending entry, view switch, date heading) | `top-bar.tsx`, `schedule-v2.tsx:303-322` | `schedule-v2.test.tsx:630-672` | ok |
| Create entries: sidebar button, narrow-screen ＋ button | `sidebar-parts.tsx:8`, `schedule-v2.tsx:356,359-371` | `schedule-v2.test.tsx:556-584` | ok |
| Google and LINE notices, pending list, retry after a failed fetch kept | `notices.tsx:55` (`ScheduleSyncAttention`), `schedule-v2.tsx:406-424`, notices retry | `schedule-v2.test.tsx:457-493, 766-772, 1078-1120` | ok |
| Colors for confirmed, pending, external | `event.tsx:71-76` | `schedule-v2.test.tsx:339-346, 710-717` | ok |
| Detail: popover wide, sheet narrow; same permission and masking; not stacked with page move | `reservation-detail-panel.tsx:58-101`, `schedule-v2.tsx:373-392` | panel `725-780`, page `496-536`, shell `565` | ok (see mocking note) |
| Popover survives the booking leaving the grid | `stable-anchor.ts` | `stable-anchor.test.tsx` (4 tests) | ok |
| 表示する予定 toggles pending and external; own blocks never hidden | `sidebar-parts.tsx:34`, `body.tsx:58-64` | `schedule-v2.test.tsx:590-628` | ok; Google vs slots is gap 3 |
| List: hidden pending says a count, not "no bookings" | `body.tsx:256-268` | `schedule-v2.test.tsx:614-627` | ok |
| Slot create keeps date; store from column (day) or selection (week); resource only when exactly one active; none: notice | `schedule-v2.tsx:203-209`, `body.tsx:106,111` | `schedule-v2.test.tsx:425-453` | ok |
| Create button opens with shown store and day, no time | `schedule-v2.tsx:212-216,398-400` | `schedule-v2.test.tsx:557-577` | ok |
| Now line and block edges at 3:1 or more against neighbours; real adjacent pairs added to the tokens test | `column.tsx:245` (surface border on `cal-alert`), `event.tsx:75,108` | `admin-calendar-tokens.test.ts:136-184` (edges on surface, today tint, closed hours, both) | ok |
| Filter and free-slot logic kept apart | `body.tsx:111-118` | `schedule-v2.test.tsx:590-602` | ok; Google half is gap 3 |
| Check: multi-store, all-stores day, per-resource external blocks, partial fetch failure | as above | `394-407`, `457-493`, `1097-1120`; per-resource blocks: none | gap 1 |
| Check: 24 hours, overlap, short booking, cleaning, booking on a stopped resource, partial failure | `geometry.ts`, `column.tsx`, `body.tsx:23-40` | `schedule-v2.test.tsx:700-708, 326-337, 894-906, 882-892, 507-518, 1097-1120` | ok |
| Selection ends when the detail closes | `schedule-v2.tsx:377` | none | gap 2 |

## Verified items

None as a whole task (see PARTIAL above).

## Unassessable items (SKIPPED)

None.

| Task | Verdict | Summary |
|---|---|---|
| T005 | 🔍 PARTIAL | Implemented and wired, all nine test files pass; 3 pinning-test gaps (per-resource external blocks, selection mark and clearing, Google toggle vs slots) |

## Walkthrough Log

Added by the implementing agent after this report was written. The sections above are unchanged.

| Flagged item | Disposition |
|---|---|
| External blocks in the all-stores day view (another store, another resource) | Fix applied: test added in `baee614`. A block on the second store's second resource lands in that store's column only. |
| Selected mark while the detail is open | Fix applied: test added in `baee614`. The pressed booking has `aria-expanded="true"` while the detail is open and `"false"` after it closes. |
| Google toggle and the free slots | Fix applied in `baee614`. The Google toggle test now also checks that the slot count does not change. |

Note on the "no time" row above: the calendar passes no time, and the shared booking form then shows its own default, 10:00. `tasks.md` now says so.

A clean re-run of the verification would re-score T005 against these tests.
