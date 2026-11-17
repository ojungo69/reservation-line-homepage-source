# Local verification: first correctness wave

2026-11-17. Baseline public source 3f65c69e64fd3999e415c83c14f5c6dfa928c13d. Only the echo expiry predicate and settings staff-response typing change production code; the other changes are tests and this feature record.

| Check | Evidence/result |
|---|---|
| Real importer expiry regression | Original query:4 failing/10 passing. Parsed-time query:14 passing, including equal/past/future and format/etag cases. The SQLite clock alone is pinned in the real lookup. |
| Related Google suites |7 files/211 passing. Existing explicit synthetic calendar binding preserved. |
| Worker runtime and build |5 files/35 passing and Worker dry-run passed for the exact changed runtime bytes. Reused child evidence after byte/reverse-patch checks. |
| Settings contract red/green | Required staff property gave TS2741; nonzero shared fixture failed both real UI output and real endpoint success. Corrected zero fixture passes actual dialog, hook and Hono/JWT/SQLite endpoint; nonzero still400. |
| Settings suites |106 frontend and136 backend passing; existing staff/owner wire-response checks remain. |
| Integrated compilers |Actual npm run typecheck and npm run admin:typecheck exit0 on combined candidate. |
| Integrated dead-code check |npm run knip exit0; two existing configuration hints only. |
| Scope |7 code/fixture files plus feature documentation. Frozen child patches apply/reverse cleanly; no dependency, schema, gate configuration or applied migration changes. |
| Graph |Initial stale graph could not resolve the helper and returned empty-symbol overbroad CRITICAL flows. After a successful bounded temporary-memory reindex, expected8 indexed changed symbols/6 tracked files/riskLOW. New JSON/docs are additionally reviewed directly. Both actual helper callers are confirmed. |

The query retains its identity-index narrowing in a synthetic plan. Real D1 planner distribution, real Google traffic and customer writes are untested. The original defect needs an identical etag; new-edit loss is not demonstrated. Public/private release gates remain separate unchecked tasks.
