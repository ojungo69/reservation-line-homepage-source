-- Activate the sample men's menus inserted (inactive) by 0046.
--
-- They were inserted with active = 0 because the deployment process applies
-- D1 migrations BEFORE publishing the new Worker. An active row would therefore be
-- bookable by the previously deployed Worker, which knows nothing about the men's
-- booking window and would accept Monday / Thursday / pre-13:00 bookings — for the
-- length of the deploy gap, or indefinitely if the deploy failed after migrating.
--
-- This migration runs only once the enforcing Worker is already serving production
-- so the window is enforced the moment the menus become visible.
--
-- Scoped by the `service_kyoto_mens_` id prefix 0046 generated, so no other store's
-- or category's menu is touched.
UPDATE services
SET active = 1
WHERE id LIKE 'service_kyoto_mens_%'
  AND mens_menu = 1
  AND active = 0;
