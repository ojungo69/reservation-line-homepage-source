PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS reservation_services (
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  display_order INTEGER NOT NULL CHECK (display_order >= 0),
  name_snapshot TEXT NOT NULL CHECK (length(name_snapshot) <= 160),
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (reservation_id, service_id),
  UNIQUE (reservation_id, display_order)
);

CREATE INDEX IF NOT EXISTS idx_reservation_services_service
ON reservation_services(service_id);

WITH public_menu(slug, name, duration_minutes) AS (
  VALUES
    ('hair_removal_full_60', '脱毛｜サンプル 11', 45),
    ('hair_removal_beard_30', '脱毛｜サンプル 09', 5),
    ('hair_removal_face_photo_45', '脱毛｜サンプル 05', 5),
    ('hair_removal_vio_women_45', '脱毛｜サンプル 01', 15),
    ('hair_removal_vio_men_45', '脱毛｜サンプル 03', 15),
    ('hair_removal_legs_45', '脱毛｜サンプル 17', 15),
    ('hair_removal_arms_15', '脱毛｜サンプル 16', 15),
    ('hair_removal_kids_full_60', '脱毛｜サンプル 07', 60),
    ('hair_removal_partial_armpits_5', '脱毛｜サンプル 23', 5),
    ('hair_removal_partial_nape_5', '脱毛｜サンプル 19', 5),
    ('hair_removal_partial_stomach_5', '脱毛｜サンプル 20', 5),
    ('hair_removal_partial_chest_5', '脱毛｜サンプル 25', 5),
    ('hair_removal_partial_back_5', '脱毛｜サンプル 24', 5),
    ('hair_removal_partial_forearms_10', '脱毛｜サンプル 22', 10),
    ('hair_removal_partial_lower_legs_10', '脱毛｜サンプル 21', 10),
    ('facial_hydra_photo_60', 'フェイシャル｜サンプル 03', 15),
    ('facial_hydra_45', 'フェイシャル｜サンプル 01', 10),
    ('facial_photo_30', 'フェイシャル｜サンプル 05', 5),
    ('default_60', 'マッサージ｜サンプル 04', 60),
    ('massage_back_long_90', 'マッサージ｜サンプル 05', 90),
    ('massage_upper_30', 'マッサージ｜サンプル 02', 30),
    ('massage_lower_30', 'マッサージ｜サンプル 03', 30),
    ('massage_kassa_60', 'マッサージ｜サンプル 01', 60),
    ('foot_korean_care_45', 'ネイル・フットケア｜サンプル 03', 45),
    ('foot_nail_one_color_60', 'ネイル・フットケア｜サンプル 01', 60)
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
  updated_at = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1
  FROM public_menu
  WHERE services.id = 'service_' || services.store_id || '_' || public_menu.slug
);

WITH public_menu(slug, name, duration_minutes) AS (
  VALUES
    ('hair_removal_full_60', '脱毛｜サンプル 11', 45),
    ('hair_removal_beard_30', '脱毛｜サンプル 09', 5),
    ('hair_removal_face_photo_45', '脱毛｜サンプル 05', 5),
    ('hair_removal_vio_women_45', '脱毛｜サンプル 01', 15),
    ('hair_removal_vio_men_45', '脱毛｜サンプル 03', 15),
    ('hair_removal_legs_45', '脱毛｜サンプル 17', 15),
    ('hair_removal_arms_15', '脱毛｜サンプル 16', 15),
    ('hair_removal_kids_full_60', '脱毛｜サンプル 07', 60),
    ('hair_removal_partial_armpits_5', '脱毛｜サンプル 23', 5),
    ('hair_removal_partial_nape_5', '脱毛｜サンプル 19', 5),
    ('hair_removal_partial_stomach_5', '脱毛｜サンプル 20', 5),
    ('hair_removal_partial_chest_5', '脱毛｜サンプル 25', 5),
    ('hair_removal_partial_back_5', '脱毛｜サンプル 24', 5),
    ('hair_removal_partial_forearms_10', '脱毛｜サンプル 22', 10),
    ('hair_removal_partial_lower_legs_10', '脱毛｜サンプル 21', 10),
    ('facial_hydra_photo_60', 'フェイシャル｜サンプル 03', 15),
    ('facial_hydra_45', 'フェイシャル｜サンプル 01', 10),
    ('facial_photo_30', 'フェイシャル｜サンプル 05', 5),
    ('default_60', 'マッサージ｜サンプル 04', 60),
    ('massage_back_long_90', 'マッサージ｜サンプル 05', 90),
    ('massage_upper_30', 'マッサージ｜サンプル 02', 30),
    ('massage_lower_30', 'マッサージ｜サンプル 03', 30),
    ('massage_kassa_60', 'マッサージ｜サンプル 01', 60),
    ('foot_korean_care_45', 'ネイル・フットケア｜サンプル 03', 45),
    ('foot_nail_one_color_60', 'ネイル・フットケア｜サンプル 01', 60)
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

WITH public_menu(slug) AS (
  VALUES
    ('hair_removal_full_60'),
    ('hair_removal_beard_30'),
    ('hair_removal_face_photo_45'),
    ('hair_removal_vio_women_45'),
    ('hair_removal_vio_men_45'),
    ('hair_removal_legs_45'),
    ('hair_removal_arms_15'),
    ('hair_removal_kids_full_60'),
    ('hair_removal_partial_armpits_5'),
    ('hair_removal_partial_nape_5'),
    ('hair_removal_partial_stomach_5'),
    ('hair_removal_partial_chest_5'),
    ('hair_removal_partial_back_5'),
    ('hair_removal_partial_forearms_10'),
    ('hair_removal_partial_lower_legs_10'),
    ('facial_hydra_photo_60'),
    ('facial_hydra_45'),
    ('facial_photo_30'),
    ('default_60'),
    ('massage_back_long_90'),
    ('massage_upper_30'),
    ('massage_lower_30'),
    ('massage_kassa_60'),
    ('foot_korean_care_45'),
    ('foot_nail_one_color_60')
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
