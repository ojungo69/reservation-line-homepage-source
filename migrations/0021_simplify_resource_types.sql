-- Consolidate all resource types to staff_calendar.
-- D1 cannot ALTER CHECK constraints, so we backfill data and enforce at code level.
UPDATE store_resources
SET resource_type = 'staff_calendar',
    updated_at = strftime('%Y-%m-%dT%H:%M:%S.000Z', 'now')
WHERE resource_type IN ('room', 'chair', 'other');
