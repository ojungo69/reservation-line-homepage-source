# verify-tasks report

- Date: 2026-11-20
- Verified head SHA: `fa6775b4bcdadcb9f99bc56b4f4eb2d2ade49c60` (detached worktree `/home/jura/projects/rlh-source-wt/t004-review`)
- Scope: branch (base `ac93d7cd1e1ce7a9b365886257dbfee1a4c9ca31` to HEAD). 4 commits: e365ebe, fc0cfb0, 2051581, fa6775b.
- Feature dir: `specs/008-admin-calendar-ux`
- Tasks verified: 1. This report verifies T004 only; earlier task reports live in git history.
- Test result: `./node_modules/.bin/vitest run test/admin-calendar-tokens.test.ts test/design-tokens-parity.test.ts` passed (2 files, 38 tests; parity file alone 33). `npx` was not used.
- Fresh session advisory: for maximum reliability, run verify-tasks in a separate agent session from the one that ran implement. This run used a fresh context.
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

None.

Notes for the reader (not flags):
- The leaf aliases `--color-cal-*` and `--mg-active-cal-*` have no consumer in `admin-app/src`, `src` or `public` yet (grep for `bg|text|border|ring|fill|stroke-cal-`, `mg-active-cal`, `mg-cal-` outside the CSS token files and tests found nothing). This is by design: the task says only the switch-on side reads them (T004b/T005). Layer 4 was treated as not_applicable (CSS custom properties are consumed by the cascade).
- "旧画面とそのテストは今のまま実行する" was not verified by running the full old-screen test suite in this run. Evidence is structural only: CSS diffs are additions only (`git diff --numstat`: glass-tokens.css 58/0, styles.css 20/0, index.css 39/0) and the 33 existing parity assertions still pass. Run the full suite in CI before merge.
- `public/styles.css` remaps the dark pairs only under `@media (prefers-color-scheme: dark)` (no `data-theme` block exists in that file); this matches how the existing `--mg-active-*` tokens are remapped there.

## T004 per-layer detail

| Layer | Result | Evidence |
|---|---|---|
| 1 File existence | positive | `public/glass-tokens.css`, `public/styles.css`, `admin-app/src/index.css`, `test/design-tokens-parity.test.ts`, `test/admin-calendar-tokens.test.ts`, `DESIGN.md` all present. |
| 2 Git diff cross-reference | positive | All of the above are in `git diff ac93d7c..HEAD --stat` (glass-tokens +58, styles.css +20, index.css +39, parity test +89/-1, new tokens test +177, DESIGN.md changed). |
| 3 Content patterns | positive | 18 `--mg-cal-*` light, 18 `--mg-dark-cal-*` dark and 18 `--mg-active-cal-*` (light default) in `public/glass-tokens.css`. Dark remap of all 18 in `public/styles.css` (media query) and `admin-app/src/index.css` (`.dark`). 18 `--color-cal-*` in the Tailwind `@theme` block of `admin-app/src/index.css`, each mapped to `var(--mg-active-cal-*)`. |
| 4 Dead-code | not_applicable | CSS tokens, consumed by cascade; no consumer yet is intended (see notes). |
| 5 Semantic | positive | Parity test pins every new token value set, the dark remap, the `--color-cal-*` mapping, and a new check that all shared tokens live in the unconditional `:root` block (with a red fixture). `admin-calendar-tokens.test.ts` computes WCAG contrast for each light/dark opaque pair (text 4.5:1, outline/icon 3:1), and for glass tiers (top bar and add button `glass-thick`, details `glass-modal`) over every backdrop including saturation-boosted backdrops and the reduced-transparency opaque fallback (`paper-elevated`). Real assertions, not stubs. DESIGN.md §3 records the tier choice, body-color-only text on the bar glass, and no outline-only controls. |

## Verified items

| Task | Verdict | Summary |
|---|---|---|

## Unassessable items (SKIPPED)

None.

## Verdict lines

| T004 | ✅ VERIFIED | Calendar tokens (18 light/dark/active/color-cal) added additively; dark remaps in both stacks; parity and contrast tests pass (38/38) at fa6775b |

## Walkthrough Log

No flagged items, so there was nothing to walk through. Addendum after this run (the sections above are the run's record and stay as written):

- The Layer 2 figure for the parity test is +88/-1 at fa6775b4 (the row above says +89/-1).
- The check that the shared tokens sit in the :root block that opens the file, including the case where :root is wrapped in an at-rule such as `@media print`, was tightened after this run and confirmed at 427be796efdf5e824410217ffe69517fe6ea59b7 (both suites red under that mutation, 38 tests passing otherwise).
