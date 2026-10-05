PRAGMA foreign_keys = ON;

UPDATE store_resources
SET
  name = CASE id
    WHEN 'resource_kyoto_calendar' THEN 'Example Calendar A'
    WHEN 'resource_osaka_calendar' THEN 'Example Calendar B'
    WHEN 'resource_nagoya_calendar' THEN 'Example Calendar C'
    WHEN 'resource_wakayama_calendar' THEN 'Example Calendar D'
    ELSE name
  END,
  updated_at = CURRENT_TIMESTAMP
WHERE id IN (
  'resource_kyoto_calendar',
  'resource_osaka_calendar',
  'resource_nagoya_calendar',
  'resource_wakayama_calendar'
);

UPDATE services
SET
  name = CASE id
    WHEN 'service_kyoto_default_60' THEN 'マッサージ｜サンプル 04'
    WHEN 'service_osaka_default_60' THEN 'マッサージ｜サンプル 04'
    WHEN 'service_nagoya_default_60' THEN 'マッサージ｜サンプル 04'
    WHEN 'service_wakayama_default_60' THEN 'マッサージ｜サンプル 04'
    ELSE name
  END,
  duration_minutes = 60,
  updated_at = CURRENT_TIMESTAMP
WHERE id IN (
  'service_kyoto_default_60',
  'service_osaka_default_60',
  'service_nagoya_default_60',
  'service_wakayama_default_60'
);

WITH public_menu(store_id, slug, name, duration_minutes) AS (
  VALUES
    ('kyoto', 'hair_removal_full_60', '脱毛｜サンプル 12', 60),
    ('kyoto', 'hair_removal_beard_30', '脱毛｜サンプル 10', 30),
    ('kyoto', 'hair_removal_face_photo_45', '脱毛｜サンプル 06', 45),
    ('kyoto', 'hair_removal_vio_women_45', '脱毛｜サンプル 02', 45),
    ('kyoto', 'hair_removal_vio_men_45', '脱毛｜サンプル 04', 45),
    ('kyoto', 'hair_removal_legs_45', '脱毛｜サンプル 18', 45),
    ('kyoto', 'hair_removal_kids_full_60', '脱毛｜サンプル 08', 60),
    ('kyoto', 'facial_hydra_photo_60', 'フェイシャル｜サンプル 04', 60),
    ('kyoto', 'facial_hydra_45', 'フェイシャル｜サンプル 02', 45),
    ('kyoto', 'facial_photo_30', 'フェイシャル｜サンプル 06', 30),
    ('kyoto', 'massage_back_long_90', 'マッサージ｜サンプル 05', 90),
    ('kyoto', 'massage_upper_30', 'マッサージ｜サンプル 02', 30),
    ('kyoto', 'massage_lower_30', 'マッサージ｜サンプル 03', 30),
    ('kyoto', 'massage_kassa_60', 'マッサージ｜サンプル 01', 60),
    ('kyoto', 'foot_korean_care_45', 'ネイル・フットケア｜サンプル 04', 45),
    ('kyoto', 'foot_nail_one_color_60', 'ネイル・フットケア｜サンプル 02', 60),
    ('osaka', 'hair_removal_full_60', '脱毛｜サンプル 12', 60),
    ('osaka', 'hair_removal_beard_30', '脱毛｜サンプル 10', 30),
    ('osaka', 'hair_removal_face_photo_45', '脱毛｜サンプル 06', 45),
    ('osaka', 'hair_removal_vio_women_45', '脱毛｜サンプル 02', 45),
    ('osaka', 'hair_removal_vio_men_45', '脱毛｜サンプル 04', 45),
    ('osaka', 'hair_removal_legs_45', '脱毛｜サンプル 18', 45),
    ('osaka', 'hair_removal_kids_full_60', '脱毛｜サンプル 08', 60),
    ('osaka', 'facial_hydra_photo_60', 'フェイシャル｜サンプル 04', 60),
    ('osaka', 'facial_hydra_45', 'フェイシャル｜サンプル 02', 45),
    ('osaka', 'facial_photo_30', 'フェイシャル｜サンプル 06', 30),
    ('osaka', 'massage_back_long_90', 'マッサージ｜サンプル 05', 90),
    ('osaka', 'massage_upper_30', 'マッサージ｜サンプル 02', 30),
    ('osaka', 'massage_lower_30', 'マッサージ｜サンプル 03', 30),
    ('osaka', 'massage_kassa_60', 'マッサージ｜サンプル 01', 60),
    ('osaka', 'foot_korean_care_45', 'ネイル・フットケア｜サンプル 04', 45),
    ('osaka', 'foot_nail_one_color_60', 'ネイル・フットケア｜サンプル 02', 60),
    ('nagoya', 'hair_removal_full_60', '脱毛｜サンプル 12', 60),
    ('nagoya', 'hair_removal_beard_30', '脱毛｜サンプル 10', 30),
    ('nagoya', 'hair_removal_face_photo_45', '脱毛｜サンプル 06', 45),
    ('nagoya', 'hair_removal_vio_women_45', '脱毛｜サンプル 02', 45),
    ('nagoya', 'hair_removal_vio_men_45', '脱毛｜サンプル 04', 45),
    ('nagoya', 'hair_removal_legs_45', '脱毛｜サンプル 18', 45),
    ('nagoya', 'hair_removal_kids_full_60', '脱毛｜サンプル 08', 60),
    ('nagoya', 'facial_hydra_photo_60', 'フェイシャル｜サンプル 04', 60),
    ('nagoya', 'facial_hydra_45', 'フェイシャル｜サンプル 02', 45),
    ('nagoya', 'facial_photo_30', 'フェイシャル｜サンプル 06', 30),
    ('nagoya', 'massage_back_long_90', 'マッサージ｜サンプル 05', 90),
    ('nagoya', 'massage_upper_30', 'マッサージ｜サンプル 02', 30),
    ('nagoya', 'massage_lower_30', 'マッサージ｜サンプル 03', 30),
    ('nagoya', 'massage_kassa_60', 'マッサージ｜サンプル 01', 60),
    ('nagoya', 'foot_korean_care_45', 'ネイル・フットケア｜サンプル 04', 45),
    ('nagoya', 'foot_nail_one_color_60', 'ネイル・フットケア｜サンプル 02', 60),
    ('wakayama', 'hair_removal_full_60', '脱毛｜サンプル 12', 60),
    ('wakayama', 'hair_removal_beard_30', '脱毛｜サンプル 10', 30),
    ('wakayama', 'hair_removal_face_photo_45', '脱毛｜サンプル 06', 45),
    ('wakayama', 'hair_removal_vio_women_45', '脱毛｜サンプル 02', 45),
    ('wakayama', 'hair_removal_vio_men_45', '脱毛｜サンプル 04', 45),
    ('wakayama', 'hair_removal_legs_45', '脱毛｜サンプル 18', 45),
    ('wakayama', 'hair_removal_kids_full_60', '脱毛｜サンプル 08', 60),
    ('wakayama', 'facial_hydra_photo_60', 'フェイシャル｜サンプル 04', 60),
    ('wakayama', 'facial_hydra_45', 'フェイシャル｜サンプル 02', 45),
    ('wakayama', 'facial_photo_30', 'フェイシャル｜サンプル 06', 30),
    ('wakayama', 'massage_back_long_90', 'マッサージ｜サンプル 05', 90),
    ('wakayama', 'massage_upper_30', 'マッサージ｜サンプル 02', 30),
    ('wakayama', 'massage_lower_30', 'マッサージ｜サンプル 03', 30),
    ('wakayama', 'massage_kassa_60', 'マッサージ｜サンプル 01', 60),
    ('wakayama', 'foot_korean_care_45', 'ネイル・フットケア｜サンプル 04', 45),
    ('wakayama', 'foot_nail_one_color_60', 'ネイル・フットケア｜サンプル 02', 60)
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
  'service_' || public_menu.store_id || '_' || public_menu.slug,
  public_menu.store_id,
  public_menu.name,
  public_menu.duration_minutes,
  0,
  0
FROM public_menu
JOIN stores ON stores.id = public_menu.store_id;

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
  'service_' || public_menu.store_id || '_' || public_menu.slug,
  public_menu.store_id
FROM public_menu
JOIN stores ON stores.id = public_menu.store_id
JOIN services ON services.id = 'service_' || public_menu.store_id || '_' || public_menu.slug;
