# Data model

No entity changes for UI identity/theme/search/Sonar cleanup. Booking consent reuses existing customer/reservation/audit state. Any notification persistence change needs a separately reviewed new migration and rollback analysis.

Google Calendar channels gain nullable sync_query_version in new0059. Existing opaque sync tokens remain stored, but unmarked tokens require a full validated walk. Terminal token and version commit together under the current claim. Old code ignores the added column, so rollback does not require deleting migration history.

Owner-approved0060 adds nullable store_closures.external_block_id with a real FK to external_blocks and a partial unique index. New all-day approvals link exactly one active admin_block in the same store; legacyNULL rows stay untouched. Authorized cancellation of either side releases both through guarded transactional triggers, with existing outbound job dedupe and audit semantics.
