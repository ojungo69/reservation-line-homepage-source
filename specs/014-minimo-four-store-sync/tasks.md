# Current source-port tasks

Historical implementation and live verification are not re-scored here. These tasks cover the current local port only.

- [X] P001 Confirm latest source base and preserve the previous feature checkout.
- [X] P002 Reuse Minimo implementation and synthetic tests; adapt shared cron/routes/error registry and keep current Google import changes.
- [X] P003 Renumber only new migrations to 0061–0063 and update current-schema upgrade fixtures.
- [X] P004 Keep runtime samples off and separate public contract documents from private operational evidence.
- [X] P005 Complete local regression, native runtime, type and bundle checks; record evidence.
- [X] P006 Complete independent correctness/security and standards review of the initial port; later migration changes have their own review task.
- [X] P007 At the earlier 48-file checkpoint, include finalized prerequisite 0059 SQL and verify populated upgrades through the then-Minimo 0062, native D1 and relevant fixture/authorization/settings guards.
- [X] P008 Include unchanged prerequisite 0060, adapt Minimo 0061–0063 to preserve explicit closure links/triggers and verify atomic failure rollback through SQLite, native D1 and actual local Wrangler. Preserve paired cancellation under both recursive-trigger modes.
- [ ] P009 Independently review the closure-preserving migration delta and its fresh verification evidence before treating this follow-up as reviewed.
- [X] P010 Three-way port only the feature delta onto normal application base `d0fe863572c3a1320f3f863eb1eafb84d2a9d5c6`; preserve both earlier feature trees, all normal runtime changes, baseline migrations and the eleven Minimo runtime files.
- [X] P011 Run current-base unit/Worker/type/Knip/build checks; correct the historical migration fixture's future-migration selection.
- [ ] P012 Independently review the latest-base integration, fixture and closure-migration delta before release preparation is accepted.

Private adoption, migration-guard/runtime-script updates and all remote activation steps remain outside this task list and require the operator's deployment workflow and explicit rollout authority.

Latest-base follow-up: 0059 and 0060 and the normal application's runtime fixes are already part of current base `d0fe863`. Minimo adds only 0061–0063. The closure compatibility change and current-base integration are not covered by the initial-port reviews. Earlier counts and manifests remain historical evidence.
