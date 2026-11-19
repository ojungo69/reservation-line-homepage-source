# verify-tasks report

- Date: 2026-11-20
- Verified head SHA: `6bd8f7a` (detached worktree `/home/jura/projects/rlh-source-wt/t004b-review`)
- Scope: branch (base `9d2435a78d0268726a3898dc95b005690445edce` to HEAD). 1 commit: 6bd8f7a "feat(admin): add the V2 admin shell behind the calendar switch (spec 008 T004b)". 15 files, +799 / -11.
- Feature dir: `specs/008-admin-calendar-ux` (no `.specify/` in this worktree; used directly)
- Tasks verified: 1. This report verifies T004b only; earlier task reports live in git history.
- Test results (one file at a time, `--maxWorkers=1`, all passed):
  - `admin-app/src/components/shell-v2/app-shell-v2.test.tsx`: 7/7
  - `admin-app/src/components/shell-v2/header-v2.test.tsx`: 3/3
  - `admin-app/src/components/shell-v2/sidebar-v2.test.tsx`: 12/12
  - `admin-app/src/components/shell-v2/store-switch-v2.test.tsx`: 3/3
  - `admin-app/src/routes.test.tsx`: 12/12
  - `test/design-tokens-parity.test.ts` (repo root): 33/33
  - Not run (by instruction): full suites, typecheck, lint, mutation checks.
- Fresh session advisory: this run used a fresh context, separate from the implementing session.
- Skipped by instruction: extension hooks, interactive walkthrough (flagged items are listed below instead).

## Scorecard

| Verdict | Count |
|---|---|
| VERIFIED | 1 |
| PARTIAL | 0 |
| WEAK | 0 |
| NOT_FOUND | 0 |
| SKIPPED | 0 |

## Flagged items

None (no NOT_FOUND / PARTIAL / WEAK).

Notes for the reader (not verdict flags; each is a limit of this run or a visible gap):
1. The task's claim "写した役目と外枠の選択を 1 つずつ壊すと、該当の試験が失敗することを確かめた" is a self-report. This run did not re-run the mutation checks (changing source files was out of scope).
2. The blur regression test (`app-shell-v2.test.tsx`) inspects class tokens only, on the docked sidebar nav and `<main>`, with the drawer closed. It does not look at the drawer's content or at computed styles. By reading: no `backdrop-blur` or `glass-*` class appears in `shell-v2/*.tsx`, the docked sidebar uses `.surface` (`backdrop-filter: none` in `public/glass-tokens.css`), and `ui/sheet.tsx` has no blur class. DESIGN.md (edited in this commit) allows blur on the open drawer itself.
3. `HeaderV2` renders on every route under `AppShellV2`, including the calendar route `/`. The task says the calendar screen's own top bar (T005) takes its place; T005 is not done, so nothing hides the header on `/` yet. Expected at this stage, and T005 must remove or hide it.
4. "切り替えがオフの本番では読み込まれない" is true by structure (`lazy(() => import(...))` in `routes.tsx`, selected in `ShellRoute` only when `calendarV2 === true`). The route test mocks the module and asserts the new shell is not rendered when the switch is off, but nothing asserts the chunk is not fetched.
5. `quickstart.md`, `DESIGN.md` and `tasks.md` (T001 note) were edited in the same commit to cover the 1024px drawer and the drawer blur. Not verified here beyond reading the diff.

## T004b per-layer detail

| Layer | Result | Evidence |
|---|---|---|
| 1 File existence | positive | All 15 referenced or changed paths exist: `admin-app/src/components/shell-v2/{app-shell-v2,header-v2,sidebar-v2,account-menu-v2,store-switch-v2}.tsx`, `pressable.ts`, four `*.test.tsx`, `admin-app/src/routes.tsx`, `admin-app/src/routes.test.tsx`. |
| 2 Git diff cross-reference | positive | Every one of them appears in `git diff 9d2435a..HEAD --stat`. |
| 3 Content patterns | positive | `AppShellV2` (default export, `app-shell-v2.tsx:19`), `ShellRoute` (`routes.tsx:41`), `SidebarV2`, `HeaderV2`, `AccountMenuV2`, `StoreSwitchV2` defined. Duties copied from `AppShell`: `useAdminPushReconcile()`, `sessionStorage.removeItem(CHUNK_RELOAD_FLAG)` in a try/catch on mount, `setDrawerOpen(false)` on `pathname` change, skip link to `#main-content`, `StoreProvider`. Sidebar: `navItemsBySection` with the `privileged` filter and the same "show a section if any item is visible" rule, pending badge on `/` (99+ cap), source link (`/source`, `_blank`, `noreferrer`), account menu with theme cycle (light to dark to system to light, same labels as `Header`) and `logout()` (sets `ACCESS_LOGOUT_PATH`). Header: palette button (`aria-keyshortcuts`), `StoreSwitchV2` (fixed for staff, plain name when 1 store, menu otherwise), menu button below 1024px. Drawer is a `Sheet` with `onNavigate` closing it. The cal-* colors used (`cal-outer`, `-surface`, `-detail`, `-text`, `-text-secondary`, `-primary`, `-selected`, `-on-selected`, `-pending`, `-on-pending`, `-grid`) are all defined in `admin-app/src/index.css`. `<main>` keeps `bg-background text-foreground` (pages keep current colors). |
| 4 Dead-code | positive | `grep -rn` over `admin-app/src` (non-test): `AppShellV2` referenced by the lazy import and `ShellRoute` in `routes.tsx`; `SidebarV2` and `HeaderV2` by `app-shell-v2.tsx`; `AccountMenuV2` by `sidebar-v2.tsx`; `StoreSwitchV2` by `header-v2.tsx`; `PRESSABLE` by four components; `NavItemV2` by `SidebarV2`; `ShellRoute` by `AppRoutes`. No dead symbol. |
| 5 Semantic | positive | No stubs, TODOs or placeholder returns. Tests assert behavior: skip link and main attributes, flag clearing and push reconcile, store selection kept across navigation, drawer closes on external navigation and on item press, palette opens, no blur class in main or docked nav (app-shell-v2); role-based menus, active item, badge and 99+, source link, account email and role, 3 theme transitions, logout (sidebar-v2); toggle state and palette (header-v2); menu, staff fixed, single store (store-switch-v2); on/off shell choice, direct `/customers`, and schedule to chart and back keeping one shell instance (routes). All 6 test files pass at head 6bd8f7a. Interpretive: the task text and the code agree on the placement of every listed part. |

## Verified items

| Task | Verdict | Summary |
|---|---|---|
| T004b | ✅ VERIFIED | All layers positive (4 not dead); 6 targeted test files pass at 6bd8f7a; see notes 1 to 5 for the limits of this run. |

## Unassessable items (SKIPPED)

None.

## Machine-parseable verdict lines

| T004b | ✅ VERIFIED | New shell, lazy route selection, copied duties and tests all present and wired; targeted tests pass at 6bd8f7a. |
