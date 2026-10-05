-- Track check-in time for reservations.
-- DB status stays 'confirmed'; the application maps
-- (status='confirmed' AND checked_in_at IS NOT NULL) to 'checked_in'.
-- This avoids D1 table recreation issues with FK-referencing child tables.
ALTER TABLE reservations ADD COLUMN checked_in_at TEXT;
