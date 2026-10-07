-- Fictional one-store installation example. Apply only after all migrations.
-- Copy to a gitignored file and replace the email and operator data before use.
-- This is separate from the four-store development fixture in seeds/dev.sql.

-- Fail at the first statement on an existing installation. D1 does not support
-- SQL RAISE outside a trigger; the existing NOT NULL name constraint is the guard.
-- No UPSERT is used: reruns cannot overwrite or reactivate the original owner.
INSERT INTO stores (id, name, timezone)
SELECT 'kyoto',
       CASE WHEN EXISTS (SELECT 1 FROM stores)
                  OR EXISTS (SELECT 1 FROM admin_users)
                  OR EXISTS (SELECT 1 FROM customers)
                  OR EXISTS (SELECT 1 FROM reservations)
            THEN NULL ELSE 'Example Store' END,
       'Asia/Tokyo';

INSERT INTO staff_members (id, store_id, display_name, role)
VALUES ('staff_login_kyoto', 'kyoto', 'Example Owner', 'owner');

-- The existing Access verifier binds this pending identity on first verified login.
-- This sentinel is not a password. No identity can sign in without verification.
INSERT INTO admin_users (id, staff_member_id, email, access_subject, role, is_service_token)
VALUES ('admin_bootstrap_owner', 'staff_login_kyoto', 'owner@example.invalid',
        'pending:bootstrap-owner', 'owner', 0);

INSERT INTO store_resources (id, store_id, name, resource_type)
VALUES ('resource_kyoto_bootstrap', 'kyoto', 'Example Capacity', 'staff_calendar');

INSERT INTO services (id, store_id, name, duration_minutes, price_amount)
VALUES ('service_kyoto_bootstrap', 'kyoto', 'Example Appointment', 30, 1000);

INSERT INTO service_stores (service_id, store_id)
VALUES ('service_kyoto_bootstrap', 'kyoto');

-- Deliberately fictional: replace these hours with the operator's actual schedule.
INSERT INTO store_business_hours (id, store_id, weekday, opens_at, closes_at) VALUES
  ('hours_bootstrap_0', 'kyoto', 0, '09:00', '18:00'),
  ('hours_bootstrap_1', 'kyoto', 1, '09:00', '18:00'),
  ('hours_bootstrap_2', 'kyoto', 2, '09:00', '18:00'),
  ('hours_bootstrap_3', 'kyoto', 3, '09:00', '18:00'),
  ('hours_bootstrap_4', 'kyoto', 4, '09:00', '18:00'),
  ('hours_bootstrap_5', 'kyoto', 5, '09:00', '18:00'),
  ('hours_bootstrap_6', 'kyoto', 6, '09:00', '18:00');
