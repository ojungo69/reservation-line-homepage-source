# Decisions

- Fix echo comparison locally instead of rewriting history. Extracted-current-SQL SQLite evidence proves same-UTC-day lexical ordering is wrong; actual importer regression is still required.
- Correct concrete role-aware typing/fixture mismatch before any shared RPC/schema machinery. Current client transport remains.
- Keep exact etag/ownership narrowing; do not infer data loss from the reproduction.
- Other work remains separately tracked. Sending, acknowledgement, restore and existing-data conversion require concrete authorized scope before action.
