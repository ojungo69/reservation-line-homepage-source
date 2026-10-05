-- Read-only preflight: every count must be zero before migration 0056 is applied.
-- Return counts only; missing historical junction/mapping rows are allowed.
-- Scalar counts avoid D1's compound SELECT term limit.
SELECT
  (SELECT COUNT(*) FROM reservations r WHERE NOT EXISTS (
    SELECT 1 FROM services s WHERE s.id = r.service_id AND s.store_id = r.store_id
  )) AS reservation_service,
  (SELECT COUNT(*) FROM reservations r WHERE NOT EXISTS (
    SELECT 1 FROM store_resources x WHERE x.id = r.resource_id AND x.store_id = r.store_id
  )) AS reservation_resource,
  (SELECT COUNT(*) FROM slot_locks l WHERE NOT EXISTS (
    SELECT 1 FROM store_resources x WHERE x.id = l.resource_id AND x.store_id = l.store_id
  )) AS slot_lock_resource,
  (SELECT COUNT(*) FROM external_blocks b WHERE NOT EXISTS (
    SELECT 1 FROM store_resources x WHERE x.id = b.resource_id AND x.store_id = b.store_id
  )) AS external_block_resource,
  (SELECT COUNT(*) FROM reservation_services rs WHERE NOT EXISTS (
    SELECT 1 FROM reservations r JOIN services s ON s.store_id = r.store_id
    WHERE r.id = rs.reservation_id AND s.id = rs.service_id
  )) AS reservation_services_store,
  (SELECT COUNT(*) FROM service_stores ss WHERE NOT EXISTS (
    SELECT 1 FROM services s WHERE s.id = ss.service_id AND s.store_id = ss.store_id
  )) AS service_stores_store;

PRAGMA foreign_key_check;
