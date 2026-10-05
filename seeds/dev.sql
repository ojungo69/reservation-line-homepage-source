-- Fictional sample stores, people, menus, calendars, and prices for local development.
-- Geographic store IDs are stable technical keys, not actual branch locations.
-- Numeric price cases are synthetic examples retained by the pricing tests.

INSERT OR IGNORE INTO stores (
  id,
  name,
  timezone,
  line_official_account_id,
  google_calendar_id
) VALUES
  ('kyoto', 'ExampleStore A', 'Asia/Tokyo', '@example-store-a', 'calendar-a@example.invalid'),
  ('osaka', 'ExampleStore B', 'Asia/Tokyo', '@example-store-b', 'calendar-b@example.invalid'),
  ('nagoya', 'ExampleStore C', 'Asia/Tokyo', '@example-store-c', 'calendar-c@example.invalid'),
  ('wakayama', 'ExampleStore D', 'Asia/Tokyo', '@example-store-d', 'calendar-d@example.invalid');

INSERT OR IGNORE INTO staff_members (
  id,
  store_id,
  display_name,
  role
) VALUES
  ('staff_owner_kyoto', 'kyoto', 'Example Owner A', 'owner'),
  ('staff_owner_osaka', 'osaka', 'Example Owner B', 'owner'),
  ('staff_owner_nagoya', 'nagoya', 'Example Owner C', 'owner'),
  ('staff_owner_wakayama', 'wakayama', 'Example Owner D', 'owner');

INSERT OR IGNORE INTO store_settings (
  store_id,
  reservation_approval_mode,
  google_controlled_edit_mode,
  max_active_reservations_per_customer
) VALUES
  ('kyoto', 'existing_customer_auto', 0, 1),
  ('osaka', 'existing_customer_auto', 0, 1),
  ('nagoya', 'existing_customer_auto', 0, 1),
  ('wakayama', 'existing_customer_auto', 0, 1);

INSERT OR IGNORE INTO store_resources (
  id,
  store_id,
  name,
  resource_type
) VALUES
  ('resource_kyoto_calendar', 'kyoto', 'Example Calendar A', 'staff_calendar'),
  ('resource_osaka_calendar', 'osaka', 'Example Calendar B', 'staff_calendar'),
  ('resource_nagoya_calendar', 'nagoya', 'Example Calendar C', 'staff_calendar'),
  ('resource_wakayama_calendar', 'wakayama', 'Example Calendar D', 'staff_calendar');

INSERT OR IGNORE INTO services (
  id,
  store_id,
  name,
  duration_minutes,
  buffer_before_minutes,
  buffer_after_minutes
) VALUES
  ('service_kyoto_default_60', 'kyoto', 'マッサージ｜サンプル 04', 60, 0, 0),
  ('service_osaka_default_60', 'osaka', 'マッサージ｜サンプル 04', 60, 0, 0),
  ('service_nagoya_default_60', 'nagoya', 'マッサージ｜サンプル 04', 60, 0, 0),
  ('service_wakayama_default_60', 'wakayama', 'マッサージ｜サンプル 04', 60, 0, 0);

INSERT OR IGNORE INTO service_stores (
  service_id,
  store_id
) VALUES
  ('service_kyoto_default_60', 'kyoto'),
  ('service_osaka_default_60', 'osaka'),
  ('service_nagoya_default_60', 'nagoya'),
  ('service_wakayama_default_60', 'wakayama');

WITH public_menu(store_id, slug, name, duration_minutes) AS (
  VALUES
    ('kyoto', 'hair_removal_full_60', '脱毛｜サンプル 11', 60),
    ('kyoto', 'hair_removal_beard_30', '脱毛｜サンプル 09', 30),
    ('kyoto', 'hair_removal_face_photo_45', '脱毛｜サンプル 05', 45),
    ('kyoto', 'hair_removal_vio_women_45', '脱毛｜サンプル 01', 45),
    ('kyoto', 'hair_removal_vio_men_45', '脱毛｜サンプル 03', 45),
    ('kyoto', 'hair_removal_legs_45', '脱毛｜サンプル 17', 45),
    ('kyoto', 'hair_removal_kids_full_60', '脱毛｜サンプル 07', 60),
    ('kyoto', 'facial_hydra_photo_60', 'フェイシャル｜サンプル 03', 60),
    ('kyoto', 'facial_hydra_45', 'フェイシャル｜サンプル 01', 45),
    ('kyoto', 'facial_photo_30', 'フェイシャル｜サンプル 05', 30),
    ('kyoto', 'massage_back_long_90', 'マッサージ｜サンプル 05', 90),
    ('kyoto', 'massage_upper_30', 'マッサージ｜サンプル 02', 30),
    ('kyoto', 'massage_lower_30', 'マッサージ｜サンプル 03', 30),
    ('kyoto', 'massage_kassa_60', 'マッサージ｜サンプル 01', 60),
    ('kyoto', 'foot_korean_care_45', 'ネイル・フットケア｜サンプル 03', 45),
    ('kyoto', 'foot_nail_one_color_60', 'ネイル・フットケア｜サンプル 01', 60),
    ('osaka', 'hair_removal_full_60', '脱毛｜サンプル 11', 60),
    ('osaka', 'hair_removal_beard_30', '脱毛｜サンプル 09', 30),
    ('osaka', 'hair_removal_face_photo_45', '脱毛｜サンプル 05', 45),
    ('osaka', 'hair_removal_vio_women_45', '脱毛｜サンプル 01', 45),
    ('osaka', 'hair_removal_vio_men_45', '脱毛｜サンプル 03', 45),
    ('osaka', 'hair_removal_legs_45', '脱毛｜サンプル 17', 45),
    ('osaka', 'hair_removal_kids_full_60', '脱毛｜サンプル 07', 60),
    ('osaka', 'facial_hydra_photo_60', 'フェイシャル｜サンプル 03', 60),
    ('osaka', 'facial_hydra_45', 'フェイシャル｜サンプル 01', 45),
    ('osaka', 'facial_photo_30', 'フェイシャル｜サンプル 05', 30),
    ('osaka', 'massage_back_long_90', 'マッサージ｜サンプル 05', 90),
    ('osaka', 'massage_upper_30', 'マッサージ｜サンプル 02', 30),
    ('osaka', 'massage_lower_30', 'マッサージ｜サンプル 03', 30),
    ('osaka', 'massage_kassa_60', 'マッサージ｜サンプル 01', 60),
    ('osaka', 'foot_korean_care_45', 'ネイル・フットケア｜サンプル 03', 45),
    ('osaka', 'foot_nail_one_color_60', 'ネイル・フットケア｜サンプル 01', 60),
    ('nagoya', 'hair_removal_full_60', '脱毛｜サンプル 11', 60),
    ('nagoya', 'hair_removal_beard_30', '脱毛｜サンプル 09', 30),
    ('nagoya', 'hair_removal_face_photo_45', '脱毛｜サンプル 05', 45),
    ('nagoya', 'hair_removal_vio_women_45', '脱毛｜サンプル 01', 45),
    ('nagoya', 'hair_removal_vio_men_45', '脱毛｜サンプル 03', 45),
    ('nagoya', 'hair_removal_legs_45', '脱毛｜サンプル 17', 45),
    ('nagoya', 'hair_removal_kids_full_60', '脱毛｜サンプル 07', 60),
    ('nagoya', 'facial_hydra_photo_60', 'フェイシャル｜サンプル 03', 60),
    ('nagoya', 'facial_hydra_45', 'フェイシャル｜サンプル 01', 45),
    ('nagoya', 'facial_photo_30', 'フェイシャル｜サンプル 05', 30),
    ('nagoya', 'massage_back_long_90', 'マッサージ｜サンプル 05', 90),
    ('nagoya', 'massage_upper_30', 'マッサージ｜サンプル 02', 30),
    ('nagoya', 'massage_lower_30', 'マッサージ｜サンプル 03', 30),
    ('nagoya', 'massage_kassa_60', 'マッサージ｜サンプル 01', 60),
    ('nagoya', 'foot_korean_care_45', 'ネイル・フットケア｜サンプル 03', 45),
    ('nagoya', 'foot_nail_one_color_60', 'ネイル・フットケア｜サンプル 01', 60),
    ('wakayama', 'hair_removal_full_60', '脱毛｜サンプル 11', 60),
    ('wakayama', 'hair_removal_beard_30', '脱毛｜サンプル 09', 30),
    ('wakayama', 'hair_removal_face_photo_45', '脱毛｜サンプル 05', 45),
    ('wakayama', 'hair_removal_vio_women_45', '脱毛｜サンプル 01', 45),
    ('wakayama', 'hair_removal_vio_men_45', '脱毛｜サンプル 03', 45),
    ('wakayama', 'hair_removal_legs_45', '脱毛｜サンプル 17', 45),
    ('wakayama', 'hair_removal_kids_full_60', '脱毛｜サンプル 07', 60),
    ('wakayama', 'facial_hydra_photo_60', 'フェイシャル｜サンプル 03', 60),
    ('wakayama', 'facial_hydra_45', 'フェイシャル｜サンプル 01', 45),
    ('wakayama', 'facial_photo_30', 'フェイシャル｜サンプル 05', 30),
    ('wakayama', 'massage_back_long_90', 'マッサージ｜サンプル 05', 90),
    ('wakayama', 'massage_upper_30', 'マッサージ｜サンプル 02', 30),
    ('wakayama', 'massage_lower_30', 'マッサージ｜サンプル 03', 30),
    ('wakayama', 'massage_kassa_60', 'マッサージ｜サンプル 01', 60),
    ('wakayama', 'foot_korean_care_45', 'ネイル・フットケア｜サンプル 03', 45),
    ('wakayama', 'foot_nail_one_color_60', 'ネイル・フットケア｜サンプル 01', 60)
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
  'service_' || store_id || '_' || slug,
  store_id,
  name,
  duration_minutes,
  0,
  0
FROM public_menu;

WITH public_menu(store_id, slug) AS (
  VALUES
    ('kyoto', 'hair_removal_full_60'),
    ('kyoto', 'hair_removal_beard_30'),
    ('kyoto', 'hair_removal_face_photo_45'),
    ('kyoto', 'hair_removal_vio_women_45'),
    ('kyoto', 'hair_removal_vio_men_45'),
    ('kyoto', 'hair_removal_legs_45'),
    ('kyoto', 'hair_removal_kids_full_60'),
    ('kyoto', 'facial_hydra_photo_60'),
    ('kyoto', 'facial_hydra_45'),
    ('kyoto', 'facial_photo_30'),
    ('kyoto', 'massage_back_long_90'),
    ('kyoto', 'massage_upper_30'),
    ('kyoto', 'massage_lower_30'),
    ('kyoto', 'massage_kassa_60'),
    ('kyoto', 'foot_korean_care_45'),
    ('kyoto', 'foot_nail_one_color_60'),
    ('osaka', 'hair_removal_full_60'),
    ('osaka', 'hair_removal_beard_30'),
    ('osaka', 'hair_removal_face_photo_45'),
    ('osaka', 'hair_removal_vio_women_45'),
    ('osaka', 'hair_removal_vio_men_45'),
    ('osaka', 'hair_removal_legs_45'),
    ('osaka', 'hair_removal_kids_full_60'),
    ('osaka', 'facial_hydra_photo_60'),
    ('osaka', 'facial_hydra_45'),
    ('osaka', 'facial_photo_30'),
    ('osaka', 'massage_back_long_90'),
    ('osaka', 'massage_upper_30'),
    ('osaka', 'massage_lower_30'),
    ('osaka', 'massage_kassa_60'),
    ('osaka', 'foot_korean_care_45'),
    ('osaka', 'foot_nail_one_color_60'),
    ('nagoya', 'hair_removal_full_60'),
    ('nagoya', 'hair_removal_beard_30'),
    ('nagoya', 'hair_removal_face_photo_45'),
    ('nagoya', 'hair_removal_vio_women_45'),
    ('nagoya', 'hair_removal_vio_men_45'),
    ('nagoya', 'hair_removal_legs_45'),
    ('nagoya', 'hair_removal_kids_full_60'),
    ('nagoya', 'facial_hydra_photo_60'),
    ('nagoya', 'facial_hydra_45'),
    ('nagoya', 'facial_photo_30'),
    ('nagoya', 'massage_back_long_90'),
    ('nagoya', 'massage_upper_30'),
    ('nagoya', 'massage_lower_30'),
    ('nagoya', 'massage_kassa_60'),
    ('nagoya', 'foot_korean_care_45'),
    ('nagoya', 'foot_nail_one_color_60'),
    ('wakayama', 'hair_removal_full_60'),
    ('wakayama', 'hair_removal_beard_30'),
    ('wakayama', 'hair_removal_face_photo_45'),
    ('wakayama', 'hair_removal_vio_women_45'),
    ('wakayama', 'hair_removal_vio_men_45'),
    ('wakayama', 'hair_removal_legs_45'),
    ('wakayama', 'hair_removal_kids_full_60'),
    ('wakayama', 'facial_hydra_photo_60'),
    ('wakayama', 'facial_hydra_45'),
    ('wakayama', 'facial_photo_30'),
    ('wakayama', 'massage_back_long_90'),
    ('wakayama', 'massage_upper_30'),
    ('wakayama', 'massage_lower_30'),
    ('wakayama', 'massage_kassa_60'),
    ('wakayama', 'foot_korean_care_45'),
    ('wakayama', 'foot_nail_one_color_60')
)
INSERT OR IGNORE INTO service_stores (
  service_id,
  store_id
)
SELECT
  'service_' || store_id || '_' || slug,
  store_id
FROM public_menu;

INSERT OR IGNORE INTO store_business_hours (
  id,
  store_id,
  weekday,
  opens_at,
  closes_at,
  active
) VALUES
  ('hours_kyoto_sun', 'kyoto', 0, '10:00', '20:00', 1),
  ('hours_kyoto_mon', 'kyoto', 1, '10:00', '20:00', 1),
  ('hours_kyoto_tue', 'kyoto', 2, '10:00', '20:00', 1),
  ('hours_kyoto_wed', 'kyoto', 3, '10:00', '20:00', 1),
  ('hours_kyoto_thu', 'kyoto', 4, '10:00', '20:00', 1),
  ('hours_kyoto_sat', 'kyoto', 6, '10:00', '20:00', 1),
  ('hours_osaka_sun', 'osaka', 0, '10:00', '20:00', 1),
  ('hours_osaka_mon', 'osaka', 1, '10:00', '20:00', 1),
  ('hours_osaka_tue', 'osaka', 2, '10:00', '20:00', 1),
  ('hours_osaka_wed', 'osaka', 3, '10:00', '20:00', 1),
  ('hours_osaka_thu', 'osaka', 4, '10:00', '20:00', 1),
  ('hours_osaka_sat', 'osaka', 6, '10:00', '20:00', 1),
  ('hours_nagoya_sun', 'nagoya', 0, '10:00', '20:00', 1),
  ('hours_nagoya_mon', 'nagoya', 1, '10:00', '20:00', 1),
  ('hours_nagoya_tue', 'nagoya', 2, '10:00', '20:00', 1),
  ('hours_nagoya_wed', 'nagoya', 3, '10:00', '20:00', 1),
  ('hours_nagoya_thu', 'nagoya', 4, '10:00', '20:00', 1),
  ('hours_nagoya_sat', 'nagoya', 6, '10:00', '20:00', 1),
  ('hours_wakayama_sun', 'wakayama', 0, '10:00', '20:00', 1),
  ('hours_wakayama_mon', 'wakayama', 1, '10:00', '20:00', 1),
  ('hours_wakayama_tue', 'wakayama', 2, '10:00', '20:00', 1),
  ('hours_wakayama_wed', 'wakayama', 3, '10:00', '20:00', 1),
  ('hours_wakayama_thu', 'wakayama', 4, '10:00', '20:00', 1),
  ('hours_wakayama_sat', 'wakayama', 6, '10:00', '20:00', 1);

WITH public_menu(slug, name, duration_minutes) AS (
  VALUES
    ('hair_removal_full_60', '脱毛｜サンプル 11', 45),
    ('hair_removal_upper_focus_45', '脱毛｜サンプル 14', 45),
    ('hair_removal_lower_focus_45', '脱毛｜サンプル 15', 45),
    ('hair_removal_growth_45', '脱毛｜サンプル 13', 45),
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
    ('hair_removal_upper_focus_45', '脱毛｜サンプル 14', 45),
    ('hair_removal_lower_focus_45', '脱毛｜サンプル 15', 45),
    ('hair_removal_growth_45', '脱毛｜サンプル 13', 45),
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

-- Explicitly store men's-window membership instead of inferring it from names or
-- IDs: admin-created services use UUID IDs and must not bypass the restriction.
-- The suffixes also preserve slot-times.ts endsWith-based full-body/photo absorption.
WITH public_menu(slug, name, duration_minutes, price_amount) AS (
  VALUES
    ('hair_removal_full_photo', 'メンズ｜サンプル 04', 55, 7000),
    ('hair_removal_full_60', 'メンズ｜サンプル 05', 55, 6000),
    ('hair_removal_growth_45', 'メンズ｜サンプル 06', 55, 6000),
    ('hair_removal_upper_focus_45', 'メンズ｜サンプル 07', 55, 6000),
    ('hair_removal_lower_focus_45', 'メンズ｜サンプル 08', 55, 6000),
    ('hair_removal_face_photo_45', 'メンズ｜サンプル 02', 10, 3000),
    ('hair_removal_beard_30', 'メンズ｜サンプル 03', 10, 2000),
    ('hair_removal_arms_15', 'メンズ｜サンプル 09', 15, 3000),
    ('hair_removal_legs_45', 'メンズ｜サンプル 10', 15, 3000),
    ('hair_removal_partial_nape_5', 'メンズ｜サンプル 11', 10, 2000),
    ('hair_removal_partial_stomach_5', 'メンズ｜サンプル 12', 10, 2000),
    ('hair_removal_partial_lower_legs_10', 'メンズ｜サンプル 13', 10, 2000),
    ('hair_removal_partial_forearms_10', 'メンズ｜サンプル 14', 10, 2000),
    ('hair_removal_partial_armpits_5', 'メンズ｜サンプル 15', 10, 2000),
    ('hair_removal_partial_thigh_10', 'メンズ｜サンプル 16', 10, 2000),
    ('hair_removal_partial_back_5', 'メンズ｜サンプル 17', 10, 2000),
    ('hair_removal_partial_chest_5', 'メンズ｜サンプル 18', 10, 2000)
)
INSERT OR IGNORE INTO services (
  id,
  store_id,
  name,
  price_amount,
  duration_minutes,
  buffer_before_minutes,
  buffer_after_minutes,
  active,
  mens_menu
)
SELECT
  'service_kyoto_mens_' || public_menu.slug,
  stores.id,
  public_menu.name,
  public_menu.price_amount,
  public_menu.duration_minutes,
  0,
  0,
  1,
  1
FROM stores
CROSS JOIN public_menu
WHERE stores.id = 'kyoto';

WITH public_menu(slug) AS (
  VALUES
    ('hair_removal_full_photo'),
    ('hair_removal_full_60'),
    ('hair_removal_growth_45'),
    ('hair_removal_upper_focus_45'),
    ('hair_removal_lower_focus_45'),
    ('hair_removal_face_photo_45'),
    ('hair_removal_beard_30'),
    ('hair_removal_arms_15'),
    ('hair_removal_legs_45'),
    ('hair_removal_partial_nape_5'),
    ('hair_removal_partial_stomach_5'),
    ('hair_removal_partial_lower_legs_10'),
    ('hair_removal_partial_forearms_10'),
    ('hair_removal_partial_armpits_5'),
    ('hair_removal_partial_thigh_10'),
    ('hair_removal_partial_back_5'),
    ('hair_removal_partial_chest_5')
)
INSERT OR IGNORE INTO service_stores (
  service_id,
  store_id
)
SELECT
  'service_kyoto_mens_' || public_menu.slug,
  stores.id
FROM stores
CROSS JOIN public_menu
WHERE stores.id = 'kyoto';

UPDATE services
SET
  name = 'メンズ｜サンプル 01',
  mens_menu = 1,
  updated_at = CURRENT_TIMESTAMP
WHERE id = 'service_kyoto_hair_removal_vio_men_45';

WITH public_menu(slug) AS (
  VALUES
    ('hair_removal_full_60'),
    ('hair_removal_upper_focus_45'),
    ('hair_removal_lower_focus_45'),
    ('hair_removal_growth_45'),
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
