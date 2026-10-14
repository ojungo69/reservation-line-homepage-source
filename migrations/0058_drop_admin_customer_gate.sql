-- Drop the staff customer-tab approval table (created by 0053). The one-time approval code was
-- removed in specs/002 and no application code reads or writes this table any more; its rows
-- (code hashes and expired grants) have no further use. The grant index goes with the table.
--
-- Rolling the application back to a version that still has the approval code is not supported
-- after this migration: that code needs this table. D1 rejects BEGIN/COMMIT, so there are no
-- transaction statements.
DROP TABLE IF EXISTS admin_customer_gate_challenges;
