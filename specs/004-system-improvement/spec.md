# System quality and usability maintenance

Owner request: 2026-11-17. Baseline: 3cd583d8106c1d49a5795dc43f934c9e300526fd.

## User stories

P1: Operators can identify the admin tab and trust visible action labels and current search results.
P1: Maintainable source passes existing CI and quality gates without weakening scope, rules or thresholds.
P2: The owner receives concrete redesign and AI/agent proposals and verified whole-project audit findings.
P2: Minimo remains a separately reviewed, disabled preparation branch until explicit production authorization.

## Requirements

- Explicit same-origin admin favicon, no dependency or authentication change.
- Theme menu action matches its stated next theme.
- LINE friend search never offers stale-row actions during debounce or refetch; errors and truncation remain distinguishable from empty results.
- Repair mutable source Sonar findings only when semantics and security remain intact. Explain necessary serial awaits, hidden CSS guarantees and immutable historical migrations rather than weaken analysis.
- Verified defects discovered during audit may be added with reproducible evidence and scoped tests. Do not repair production data or change business policy without owner decision.
- Preserve role/store authorization, idempotency, booking locks, notification order, SQL/schema and API contracts unless a separately documented bug requires a minimal guard.
- Redesign and AI are proposals, not permission to replace the current product flow or send data to a new model provider.

## Completion criteria

Focused regressions and mandatory whole-project checks pass; standards/spec reviews complete; source changes ship through source CI/Sonar then private adoption/staging/promotion/live validation. Minimo is excluded from that release. Audit read coverage and unresolved decisions are explicit.

## Owner decisions during audit

Owner approved that new Google all-day-as-closure approvals have durable pairing: cancelling either the closure or its mirror block releases both atomically. Existing unlinked data is not guessed or bulk repaired. Owner also approved showing unconfigured hours as 未設定・予約受付不可 in admin, with no write on viewing and no implicit opening on first save. Configured and explicitly closed schedules remain intact.
