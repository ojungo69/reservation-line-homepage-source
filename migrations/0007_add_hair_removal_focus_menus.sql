PRAGMA foreign_keys = ON;

WITH public_menu(slug, name, duration_minutes) AS (
  VALUES
    ('hair_removal_upper_focus_45', '脱毛｜サンプル 14', 45),
    ('hair_removal_lower_focus_45', '脱毛｜サンプル 15', 45),
    ('hair_removal_growth_45', '脱毛｜サンプル 13', 45)
)
INSERT OR IGNORE INTO services (
  id,
  store_id,
  name,
  duration_minutes,
  buffer_before_minutes,
  buffer_after_minutes
)
SELECT
  'service_' || stores.id || '_' || public_menu.slug,
  stores.id,
  public_menu.name,
  public_menu.duration_minutes,
  0,
  0
FROM stores
CROSS JOIN public_menu;

WITH public_menu(slug, name, duration_minutes) AS (
  VALUES
    ('hair_removal_upper_focus_45', '脱毛｜サンプル 14', 45),
    ('hair_removal_lower_focus_45', '脱毛｜サンプル 15', 45),
    ('hair_removal_growth_45', '脱毛｜サンプル 13', 45)
)
UPDATE services
SET
  name = (
    SELECT public_menu.name
    FROM public_menu
    WHERE services.id = 'service_' || services.store_id || '_' || public_menu.slug
  ),
  duration_minutes = (
    SELECT public_menu.duration_minutes
    FROM public_menu
    WHERE services.id = 'service_' || services.store_id || '_' || public_menu.slug
  ),
  buffer_before_minutes = 0,
  buffer_after_minutes = 0,
  active = 1,
  updated_at = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1
  FROM public_menu
  WHERE services.id = 'service_' || services.store_id || '_' || public_menu.slug
);

WITH public_menu(slug) AS (
  VALUES
    ('hair_removal_upper_focus_45'),
    ('hair_removal_lower_focus_45'),
    ('hair_removal_growth_45')
)
INSERT OR IGNORE INTO service_stores (
  service_id,
  store_id
)
SELECT
  'service_' || stores.id || '_' || public_menu.slug,
  stores.id
FROM stores
CROSS JOIN public_menu;
