# Data model

No entity changes for UI identity/theme/search/Sonar cleanup. Booking consent reuses existing customer/reservation/audit state. Any notification persistence change needs a separately reviewed new migration and rollback analysis.

Google Calendar channels gain nullable sync_query_version in new0059. Existing opaque sync tokens remain stored, but unmarked tokens require a full validated walk. Terminal token and version commit together under the current claim. Reviewed rollback retains the applied schema and the versioned query/token/watch contract, using new source/private revisions. Migration history is preserved.

Owner-approved0060 adds nullable store_closures.external_block_id with a real FK to external_blocks and a partial unique index. New all-day approvals link exactly one active admin_block in the same store; legacyNULL rows stay untouched. Authorized cancellation of either side releases both through guarded transactional triggers, with existing outbound job dedupe and audit semantics.

Booking catalog guards pin each selected service ID and duration at the atomic write boundary; completed reservation/idempotency snapshots remain unchanged. Expired exact admin-action keys can be reclaimed independently of their old payload/target, while live-key conflicts remain protected.

Linked closure intervals are immutable through the generic closure editor. The authoritative store/link/interval is checked at the write boundary; reason-only changes remain allowed. To change dates, cancel the linked closure, create the replacement Google event and approve it as a closure. Legacy NULL-linked closures keep their normal editing behavior.

Concurrent replay is checked before catalog rejection. Failed idempotency reads remain an uncertain write_failed response, distinct from confirmed absence; neither public nor admin creation may replace that uncertainty with a definitive catalog failure.
