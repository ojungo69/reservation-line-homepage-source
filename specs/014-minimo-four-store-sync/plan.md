# Source-port implementation plan

Current base: `d0fe863572c3a1320f3f863eb1eafb84d2a9d5c6`. The feature patch was three-way applied using its earlier `3cd583d8106c1d49a5795dc43f934c9e300526fd` base. Scope: reuse the existing Minimo implementation on the current normal application; leave production, private runtime values and both earlier feature checkouts unchanged.

## Changes and impact

- Reuse `src/minimo/` configuration, parsers, transport, session encryption, inbound/outbound/state and runner, plus `src/admin/minimo-sync.ts`.
- Connect the existing scheduled handler and authenticated admin routes. Keep current Google import handling and its etag preservation. Protect managed blocks in ordinary cancellation and Google conflict recovery.
- Keep the three unshipped Minimo migrations at 0061–0063 after application migrations 0059 (Google query provenance) and 0060 (explicit all-day closure/block pairing), now already in the base. Preserve those prerequisite bytes. The unapplied Minimo table rebuild retains explicit closure links and the five pairing triggers atomically, without cancellation effects or inferred legacy links. Retain the current application's claim fences, default fetcher behavior, consent, business-hours and all-day changes. Update the historical 0060 upgrade fixture to apply only migrations earlier than its target; future migrations must not run before 0060.
- Keep public runtime samples disabled. Private deployment workflow changes, migration-guard threshold, runtime secret allowlists and source-lock adoption remain operator-owned follow-up work.
- Port synthetic tests and document the shared contract without private operational evidence. No new dependencies, admin SPA or provider permissions are added.

The source graph index predates this base. An exact impact lookup could resolve conflict recovery but not the current cancellation/scheduled symbols; current definitions and every text-resolved caller were inspected as the fallback. Relevant runtime entrypoints are admin cancellation, conflict resolution and the ten-minute scheduled handler. Shared regression suites remain required.

## Completion and verification

Run generated Worker types and typecheck, focused Minimo/authorization/cancellation/Google/cron tests, populated native-D1/workerd checks, public installation fixtures, Knip and bundle dry-run. Review source and security boundaries and preserve the original implementation except where current integration requires adjustment. Record actual commands, counts and any unavailable checks in validation.md.

Completion for this port is a reviewed local diff and handoff. Commit, push, PR, merge, private adoption, secret synchronization and deployment are excluded. Keep mode off for runtime stop; retain imports/locks/ownership and use reference-preserving backup/recovery if schema recovery is later authorized.
