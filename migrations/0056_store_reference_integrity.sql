-- Expand-only store integrity. No data rewrite or table rebuild.
-- Existing single-column FKs do not prove that service/resource and store match.
-- Missing legacy reservation_services/service_stores rows remain valid.
-- Run scripts/check-store-integrity.sql before applying; repair existing violations
-- separately. These triggers validate future writes, not historical rows.

CREATE TRIGGER IF NOT EXISTS trg_reservations_store_reference_insert
BEFORE INSERT ON reservations
WHEN NOT EXISTS (SELECT 1 FROM services WHERE id = NEW.service_id AND store_id = NEW.store_id)
  OR NOT EXISTS (SELECT 1 FROM store_resources WHERE id = NEW.resource_id AND store_id = NEW.store_id)
BEGIN
  SELECT RAISE(ABORT, 'store_reference_mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_reservations_store_reference_update
BEFORE UPDATE OF store_id, service_id, resource_id ON reservations
WHEN NOT EXISTS (SELECT 1 FROM services WHERE id = NEW.service_id AND store_id = NEW.store_id)
  OR NOT EXISTS (SELECT 1 FROM store_resources WHERE id = NEW.resource_id AND store_id = NEW.store_id)
  OR EXISTS (
    SELECT 1 FROM reservation_services rs
    JOIN services s ON s.id = rs.service_id
    WHERE rs.reservation_id = OLD.id AND s.store_id != NEW.store_id
  )
BEGIN
  SELECT RAISE(ABORT, 'store_reference_mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_slot_locks_store_reference_insert
BEFORE INSERT ON slot_locks
WHEN NOT EXISTS (SELECT 1 FROM store_resources WHERE id = NEW.resource_id AND store_id = NEW.store_id)
BEGIN
  SELECT RAISE(ABORT, 'store_reference_mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_slot_locks_store_reference_update
BEFORE UPDATE OF store_id, resource_id ON slot_locks
WHEN NOT EXISTS (SELECT 1 FROM store_resources WHERE id = NEW.resource_id AND store_id = NEW.store_id)
BEGIN
  SELECT RAISE(ABORT, 'store_reference_mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_external_blocks_store_reference_insert
BEFORE INSERT ON external_blocks
WHEN NOT EXISTS (SELECT 1 FROM store_resources WHERE id = NEW.resource_id AND store_id = NEW.store_id)
BEGIN
  SELECT RAISE(ABORT, 'store_reference_mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_external_blocks_store_reference_update
BEFORE UPDATE OF store_id, resource_id ON external_blocks
WHEN NOT EXISTS (SELECT 1 FROM store_resources WHERE id = NEW.resource_id AND store_id = NEW.store_id)
BEGIN
  SELECT RAISE(ABORT, 'store_reference_mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_reservation_services_store_reference_insert
BEFORE INSERT ON reservation_services
WHEN NOT EXISTS (
  SELECT 1 FROM reservations r JOIN services s ON s.store_id = r.store_id
  WHERE r.id = NEW.reservation_id AND s.id = NEW.service_id
)
BEGIN
  SELECT RAISE(ABORT, 'store_reference_mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_reservation_services_store_reference_update
BEFORE UPDATE OF reservation_id, service_id ON reservation_services
WHEN NOT EXISTS (
  SELECT 1 FROM reservations r JOIN services s ON s.store_id = r.store_id
  WHERE r.id = NEW.reservation_id AND s.id = NEW.service_id
)
BEGIN
  SELECT RAISE(ABORT, 'store_reference_mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_service_stores_store_reference_insert
BEFORE INSERT ON service_stores
WHEN NOT EXISTS (SELECT 1 FROM services WHERE id = NEW.service_id AND store_id = NEW.store_id)
BEGIN
  SELECT RAISE(ABORT, 'store_reference_mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_service_stores_store_reference_update
BEFORE UPDATE OF service_id, store_id ON service_stores
WHEN NOT EXISTS (SELECT 1 FROM services WHERE id = NEW.service_id AND store_id = NEW.store_id)
BEGIN
  SELECT RAISE(ABORT, 'store_reference_mismatch');
END;

-- Matches the existing settings guardImmutableStore contract and prevents parent
-- updates from invalidating previously checked children.
CREATE TRIGGER IF NOT EXISTS trg_services_immutable_store
BEFORE UPDATE OF store_id ON services
WHEN NEW.store_id IS NOT OLD.store_id
BEGIN
  SELECT RAISE(ABORT, 'immutable_store');
END;

CREATE TRIGGER IF NOT EXISTS trg_store_resources_immutable_store
BEFORE UPDATE OF store_id ON store_resources
WHEN NEW.store_id IS NOT OLD.store_id
BEGIN
  SELECT RAISE(ABORT, 'immutable_store');
END;
