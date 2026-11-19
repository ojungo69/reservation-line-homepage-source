# speckit-verify-tasks report: T004b only

- Verified head SHA: `4731416d1ac40f7c00f974ff671e780167d52dcc` (as printed by `git rev-parse HEAD` in a detached review worktree)
- Date: 2026-11-19 (UTC, `date -u`)
- Scope: branch, base ref `9d2435a78d0268726a3898dc95b005690445edce` (6 commits, 19 files)
- Verifies T004b ONLY. Reports for earlier tasks live in git history.
- Fresh session advisory: this run was made in a separate context from the implementing agent, as the skill recommends.
- Skipped on purpose: extension hooks (the worktree has no `.specify/`), and the interactive walkthrough (flagged items are listed below instead). `FEATURE_DIR` was set directly to `specs/008-admin-calendar-ux`.

## Test results (run one file at a time, `--maxWorkers=1`, never the full suites)

| File | Result |
|---|---|
| `admin-app/src/components/shell-v2/app-shell-v2.test.tsx` | 24/24 passed |
| `admin-app/src/components/shell-v2/header-v2.test.tsx` | 4/4 passed |
| `admin-app/src/components/shell-v2/sidebar-v2.test.tsx` | 12/12 passed |
| `admin-app/src/components/shell-v2/store-switch-v2.test.tsx` | 4/4 passed |
| `admin-app/src/routes.test.tsx` | 12/12 passed |
| `admin-app/src/routes.lazy-shell.test.tsx` | 1/1 passed |
| `test/design-tokens-parity.test.ts` (repo root) | 33/33 passed |

Not run (outside the allowed commands): `tsc -b`, lint, the full suites, any mutation run.

## Scorecard

| Verdict | Count |
|---|---|
| VERIFIED | 1 (T004b) |
| PARTIAL / WEAK / NOT_FOUND / SKIPPED | 0 |

## Verdict line

| T004b | ✅ VERIFIED | All 5 layers positive; 4 claims have no pinning test or only a partial one (see Flagged items) |

## Per-layer result

| Layer | Result | Evidence |
|---|---|---|
| 1 File existence | positive | `admin-app/src/components/shell-v2/` holds `app-shell-v2.tsx`, `header-v2.tsx`, `sidebar-v2.tsx`, `account-menu-v2.tsx`, `store-switch-v2.tsx`, `pressable.ts` and 4 `*.test.tsx`; `admin-app/src/routes.tsx`, `routes.test.tsx`, `routes.lazy-shell.test.tsx` exist |
| 2 Diff cross-reference | positive | every file above is in `git diff 9d2435a..HEAD` (the shell-v2 files are new; `routes.tsx`, `routes.test.tsx` changed; `routes.lazy-shell.test.tsx` new) |
| 3 Content patterns | positive | `export default function AppShellV2` (app-shell-v2.tsx:27), `function ShellRoute` (routes.tsx:41), `function ScheduleRoute` (routes.tsx:35, pre-existing), `lazy(() => import("@/components/shell-v2/app-shell-v2"))` (routes.tsx:10) |
| 4 Dead-code | positive | `grep -rn` over `admin-app/src` excluding tests: `AppShellV2` 4 refs, `ShellRoute` 2, `HeaderV2` 4, `SidebarV2` 6, `AccountMenuV2` 4, `StoreSwitchV2` 3, `PRESSABLE` 11, `MENU_ITEM_FOCUS` 7, `DOCKED_QUERY` 2. `<ShellRoute />` is the layout route element (routes.tsx:49) |
| 5 Semantic | positive (interpretive) | Implementations are real, not stubs. Every `cal-*` token class the shell uses is defined in `admin-app/src/index.css` (`--color-cal-outer`, `-surface`, `-detail`, `-grid`, `-primary`, `-selected`, `-on-selected`, `-pending`, `-on-pending`, `-text`, `-text-secondary`), so no class is silently unstyled. Store-switch rules match the current `Header` (`!isStoreFixed && stores.length > 1`). Privilege filter and pending-count rule match the current `Sidebar` |

## Claim-by-claim check (T004b text vs code vs test)

"Pinned by" names the test that fails if the behavior is removed, judged by reading the assertion. "None" means no test asserts it.

| # | T004b claim | Code | Pinned by |
|---|---|---|---|
| 1 | `AppShellV2` is chosen on the switch's on side in `ShellRoute`, with the same judgment as `ScheduleRoute` (`calendarV2 === true`) | routes.tsx:41-42, :49 | `routes.test.tsx`: on gives new shell; off, `{}`, `{calendarV2:false}`, `{calendarV2:"true"}` give the current shell (`it.each(OFF)`); `/customers` direct open in both; schedule to chart and back keeps one shell instance. Both shells are mocked there, so only the choice is pinned |
| 2 | New shell is lazy and is not loaded when the switch is off | routes.tsx:10 | `routes.lazy-shell.test.tsx` (module-factory flag stays false after import of routes and after a render with the switch off) |
| 3 | Header shown on non-calendar pages; calendar header hiding is T005 (until then it shows there too) | `HeaderV2` always rendered (app-shell-v2.tsx:139) | `header-v2.test.tsx` (button, palette, store switch). No test for the calendar-route case, correct because it is T005 work |
| 4 | Sidebar holds: nav + privilege filter | sidebar-v2.tsx:89-94 | `sidebar-v2.test.tsx` owner (3 groups, privileged items) and staff (privileged hidden, settings group kept) |
| 5 | Sidebar holds: pending count | sidebar-v2.tsx:77, :38-48 | `sidebar-v2.test.tsx` (accessible name carries real count, `99+` cap, none at 0) |
| 6 | Sidebar holds: source code link | sidebar-v2.tsx:98-106 | `sidebar-v2.test.tsx` (href `/source`, `_blank`, `noreferrer`) |
| 7 | Sidebar holds: account menu with theme and logout | account-menu-v2.tsx | `sidebar-v2.test.tsx` (email and role label, 3 theme transitions via `onThemeChange`, logout called once) |
| 8 | Header holds: page move | header-v2.tsx:38-50; app-shell-v2.tsx:144, :157 | `header-v2.test.tsx` (opener passed), `app-shell-v2.test.tsx` "ページ移動を外枠から開く" |
| 9 | Header holds: store switch; staff fixed; one visible store shows its name | store-switch-v2.tsx:19-34 | `store-switch-v2.test.tsx` (4 tests: staff before load shows "店舗", multi-store menu, staff fixed, single store). Selection survives page moves: `app-shell-v2.test.tsx` "選んだ店舗を、画面を移っても保つ" |
| 10 | Below 64rem the sidebar is a drawer; judgment same as Tailwind lg | `DOCKED_QUERY = "(min-width: 64rem)"` (app-shell-v2.tsx:17) | `app-shell-v2.test.tsx` "広い画面の判定は Tailwind の lg と同じ値" compares with `tailwindcss/defaultTheme` `screens.lg`. This is Tailwind's JS copy, not the app's built CSS; `admin-app/src` has no `--breakpoint-lg` override, so the two agree today |
| 11 | One sidebar at a time | app-shell-v2.tsx:102-136 (ternary) | `app-shell-v2.test.tsx` (`navs()` length 1 docked; 0 closed drawer; 1 open drawer) |
| 12 | Widening to 64rem or more closes the drawer; narrowing does not reopen it | app-shell-v2.tsx:58-60 | `app-shell-v2.test.tsx` "画面が 1024px 以上に広がると引き出しを閉じ、また狭くなっても勝手に開かない" |
| 13 | Skip to main link | app-shell-v2.tsx:95-100, :147-154 | `app-shell-v2.test.tsx` "本文へスキップのリンクと、本文の main を持つ" |
| 14 | Docked sidebar: no shadow, no blur | app-shell-v2.tsx:105 | `app-shell-v2.test.tsx` blur test (no `surface`/`shadow*` class on `<aside>`, no `backdrop-`/`blur`/`glass-` class on main, banner, aside, nav) |
| 15 | Docked sidebar: glass-like fill (same as the sample) | `bg-linear-to-b from-cal-surface to-cal-detail ring-1 ring-inset ring-cal-grid`, dark swapped | None for the positive fill. Only the absence of blur and shadow is asserted. "Same as the sample" cannot be checked from this tree |
| 16 | Drawer width capped at 86% of the screen | `w-72 max-w-[86vw]` (app-shell-v2.tsx:114); `sm:max-w-sm` from the Sheet variant is wider than 288px, so the cap governs below 640px | None (no test mentions `86vw`) |
| 17 | Drawer open: focus goes to the current page item (first nav link if none) | `onOpenAutoFocus` (app-shell-v2.tsx:116-124) | `app-shell-v2.test.tsx` two tests (`/customers` gives 顧客; `/no-such-page` gives first link) |
| 18 | Drawer close returns focus to the opener (menu button) | `onCloseAutoFocus` (app-shell-v2.tsx:125-130) | `app-shell-v2.test.tsx` Esc test; item-press test; widening test (focus to main instead) |
| 19 | Page move close returns focus to the pressed button, or to what had focus for Cmd/Ctrl+K, else main; unfocusable or missing place gives main | app-shell-v2.tsx:65-80 | `app-shell-v2.test.tsx` four tests: button return; Safari no-focus click via `fireEvent.click`; opener disabled gives main; Ctrl+K with nothing focused gives main |
| 20 | Opening page move closes the drawer | app-shell-v2.tsx:65-72 | `app-shell-v2.test.tsx` "ページ移動を開くと引き出しを閉じ、モーダルを重ねない". Mock palette, so focus handover from drawer to the real Radix palette is not exercised (see flagged 3) |
| 21 | Page change that removes the focused element moves focus to the new page's main | app-shell-v2.tsx:85-90 | `app-shell-v2.test.tsx` "ページ移動で戻した場所が、続く画面の切り替えで消えたら…" (navigate from outside after a palette round trip) |
| 22 | Theme state held by the shell; kept when the drawer is reopened | app-shell-v2.tsx:39; account-menu-v2.tsx takes props | `app-shell-v2.test.tsx` "保存できない環境でも、引き出しを開き直したときに選んだテーマを保つ" (storage blocked, reopen shows the chosen theme) |
| 23 | Copied duty: chunk-reload flag cleared | app-shell-v2.tsx:49-55 | `app-shell-v2.test.tsx` "読み込み直しの印を消し…" |
| 24 | Copied duty: push subscription reconcile | app-shell-v2.tsx:45 | same test (`reconcile` called) |
| 25 | Copied duty: page move / item press closes the drawer | app-shell-v2.tsx:58-60, :133 | `app-shell-v2.test.tsx` "画面が外から変わっても閉じる", "今の画面の項目を押しても閉じ…"; `sidebar-v2.test.tsx` `onNavigate` called |
| 26 | Copied duty: store state (`StoreProvider`) | app-shell-v2.tsx:93 | `app-shell-v2.test.tsx` store selection survives a page move (real `StoreProvider`) |
| 27 | New colors only in the shell; page bodies keep current colors | app-shell-v2.tsx:151 (`bg-background text-foreground`) | `app-shell-v2.test.tsx` "本文は今の色のまま…" (main has `bg-background`/`text-foreground`, no `bg-cal-*`/`text-cal-*`). Page contents are not scanned; that is outside T004b |
| 28 | No blur in scroll areas (body and menu) | main and nav have no blur classes; `<main>` and `<nav>` are the scrollers | `app-shell-v2.test.tsx` blur test (main, banner, aside, nav) |
| 29 | Drawer material: outer Sheet panel has `glass-modal`; the scroll areas inside it have no blur | `ui/sheet.tsx` panel class `glass-modal`; inner `div.overflow-y-auto` and the sidebar `nav.overflow-y-auto` carry no blur | `app-shell-v2.test.tsx` "引き出しのガラスは外側の面だけにし…" (panel has `glass-modal`, panel itself is not a scroller, at least 2 scrollers inside, none with blur-class tokens) |
| 30 | "Breaking each copied duty and the shell choice one at a time makes the matching test fail" | n/a | NOT reproduced here (no file changes allowed, no mutation run). Taken as the implementer's claim; see flagged 4 |

## Flagged items (no walkthrough; listed only)

None is a phantom completion. These are claims in the T004b text that no test pins, or pins only in part.

1. Drawer width cap `max-w-[86vw]` (claim 16): no test. Removing the cap would leave all 7 files green. The behavior is correct in code today.
2. Docked sidebar glass-like fill (claim 15): the gradient and hairline ring are not asserted. Only "no blur, no shadow, no `surface`" is. Whether it looks like the approved sample is a visual check this run cannot do.
3. Palette opened over an open drawer (claim 20): the drawer's `onCloseAutoFocus` calls `menuButtonRef.focus()` while the palette is opening. Tests use a mock palette with no focus trap, so the interplay with the real Radix dialog is not exercised. On palette close, the code falls back to `main` (the opener was inside the unmounted drawer). Worth one check on the real palette in a browser.
4. Mutation claim (claim 30): this run did not repeat it, so it is unverified by this report. Tests that look weakest if mutated: breakpoint (claim 10, compares to Tailwind's JS defaults, not built CSS) and the Sheet `glass-modal` check (class-name based, so it cannot see CSS that applies blur to a non-`glass-` class).
5. Route tests mock both shells (claim 1), so the real `AppShellV2` default export through `lazy()` in the real routes is covered only by type check and the app build, neither run here.
