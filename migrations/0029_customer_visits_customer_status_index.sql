-- Covering index for the admin customer-list visit aggregation.
--
-- listAllCustomers (src/admin/customers.ts) computes visitCount/lastVisitAt with
-- correlated subqueries over customer_visits filtered by
-- (customer_id, status='valid'):
--   COUNT(*)            -- visitCount
--   MAX(cv.visited_at)  -- lastVisitAt
-- Without an index each listed row triggers a full-table scan of customer_visits;
-- at LIMIT 200 that is up to ~400 scans per page load, growing with the ledger.
--
-- The index leads with customer_id (the correlation), then status (the filter),
-- then visited_at so BOTH subqueries are answered from the index alone:
-- COUNT counts matching index entries, and MAX reads visited_at off the index
-- tail — no table access (covering index). (gemini)
--
-- D1 rule: no BEGIN/COMMIT in migrations (wrangler wraps each file).
CREATE INDEX IF NOT EXISTS idx_customer_visits_customer_status_visited
  ON customer_visits(customer_id, status, visited_at);
