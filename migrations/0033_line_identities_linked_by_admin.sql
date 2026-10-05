-- LINE identity "manually linked to a known/existing customer by an admin" marker.
-- Additive only (mirrors 0028's nullable-column pattern, but this flag is a
-- NOT NULL 0/1 with a constant DEFAULT so ADD COLUMN succeeds on a populated
-- table).
--
-- Why: the admin "LINE友だち紐付け" flow used to seed a fake customer_visits row
-- dated "today" (visit_source='paper_chart_import') purely so the linked customer
-- counted as "existing" (valid_visit_count > 0) and auto-confirmed on their next
-- LINE booking. That polluted the visible 来店履歴 with a visit that never
-- happened. We replace that hack with an explicit provenance flag: linkLineFriend
-- now sets linked_by_admin=1 and seeds NO visit, and the booking auto-confirm gate
-- treats linked_by_admin=1 OR valid_visit_count>0 as "existing customer".
--
-- linked_by_admin is written ONLY by linkLineFriend, which is gated by
-- isAdminPrivileged (owner / system_admin) — never by a plain staff member and
-- never by the self-service public booking path. It is monotonic 0->1 (no unlink
-- path), so the auto-confirm gate read needs no transactional guard.

ALTER TABLE line_identities
  ADD COLUMN linked_by_admin INTEGER NOT NULL DEFAULT 0
    CHECK (linked_by_admin IN (0, 1));

-- Backfill: customers linked by an admin BEFORE this migration carry the old
-- paper_chart_import seed visit (so they still auto-confirm via valid_visit_count
-- > 0). Stamp linked_by_admin=1 on their identities so they remain "existing"
-- even if an owner later deletes that seed visit through the new
-- visit-history delete control. Purely corrective; leaves customer_visits
-- untouched.
UPDATE line_identities
SET linked_by_admin = 1
WHERE linked_by_admin <> 1
  AND id IN (
    SELECT li.id
    FROM line_identities li
    JOIN customer_visits cv ON cv.customer_id = li.customer_id
    WHERE cv.visit_source = 'paper_chart_import'
      AND cv.status = 'valid'
  );
