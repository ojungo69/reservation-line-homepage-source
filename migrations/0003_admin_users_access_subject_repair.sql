-- Repairs prelaunch D1 databases whose 0001 migration history exists but whose
-- admin_users table was created before Access subject binding was added.
--
-- This repair is intentionally empty-table only. If admin users are already
-- registered, stop and backfill with an operator-reviewed script so real
-- Cloudflare Access subjects are not replaced by row IDs.

DROP TABLE IF EXISTS admin_users_0003_rebuild;
DROP TABLE IF EXISTS admin_users_0003_empty_guard;

CREATE TABLE admin_users_0003_empty_guard (
  row_count INTEGER NOT NULL CHECK (row_count = 0)
);

INSERT INTO admin_users_0003_empty_guard (row_count)
SELECT COUNT(*) FROM admin_users;

DROP TABLE admin_users_0003_empty_guard;

CREATE TABLE admin_users_0003_rebuild (
  id TEXT PRIMARY KEY,
  staff_member_id TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  email TEXT NOT NULL UNIQUE,
  access_subject TEXT NOT NULL UNIQUE CHECK (length(access_subject) <= 256),
  role TEXT NOT NULL CHECK (role IN ('owner', 'staff', 'system_admin')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO admin_users_0003_rebuild (
  id,
  staff_member_id,
  email,
  access_subject,
  role,
  active,
  last_seen_at,
  created_at,
  updated_at
)
SELECT
  id,
  staff_member_id,
  email,
  id,
  role,
  active,
  last_seen_at,
  created_at,
  updated_at
FROM admin_users;

DROP TABLE admin_users;

ALTER TABLE admin_users_0003_rebuild RENAME TO admin_users;

CREATE INDEX IF NOT EXISTS idx_admin_users_staff ON admin_users(staff_member_id);
