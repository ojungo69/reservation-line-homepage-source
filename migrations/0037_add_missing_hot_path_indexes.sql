-- Add four indexes for hot-path lookups that currently fall back to full table
-- scans (verified by reading every CREATE INDEX in migrations/ and the querying
-- call sites). None of these tables had an index covering the access pattern
-- below; slot_locks' UNIQUE(store_id,resource_id,slot_at) already covers the
-- availability range scan, so that one is intentionally not duplicated here.

-- store_closures: business-hours.ts, import-sync.ts (per-slot during full
-- reconcile) and public-options.ts all query
-- `WHERE store_id = ? AND starts_at < ? AND ends_at > ?`. The table had no index
-- at all, so each check scanned the whole table.
CREATE INDEX IF NOT EXISTS idx_store_closures_store_time
  ON store_closures(store_id, starts_at, ends_at);

-- google_calendar_conflicts: the dedup guards in import-sync.ts (3 sites, both
-- incremental and full-reconcile paths) filter `WHERE calendar_id = ? AND
-- google_event_id = ?`. No existing index leads with calendar_id, so those
-- lookups full-scan. resolution_status is appended only so the post-match status
-- check is answered from the index too; it does NOT serve resolution_status-only
-- queries (not a leading column) — the open-conflict counts keep using the
-- existing idx_google_conflicts_resolution(resolution_status, created_at).
CREATE INDEX IF NOT EXISTS idx_google_conflicts_event
  ON google_calendar_conflicts(calendar_id, google_event_id, resolution_status);

-- slot_locks: every reservation state transition (approve / cancel / expire /
-- hard-delete) and customer-delete guard query
-- `WHERE owner_type = 'reservation' AND owner_id = ?`. The existing indexes
-- (expires_at; UNIQUE store_id,resource_id,slot_at) do not cover owner lookups.
CREATE INDEX IF NOT EXISTS idx_slot_locks_owner
  ON slot_locks(owner_type, owner_id);

-- reservation_change_requests: the customer hard-delete guard SELECT and the
-- notification DELETE subquery filter `WHERE customer_id = ?`. No index existed
-- on customer_id (only the implicit reservation_id FK paths).
CREATE INDEX IF NOT EXISTS idx_change_requests_customer
  ON reservation_change_requests(customer_id);
