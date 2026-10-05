-- Fictional menu labels and numeric sample prices; IDs and time semantics are stable.
-- Explicitly store whether a service is subject to the men's booking window.
-- Names and ID conventions are not authoritative: services created in the admin
-- screen receive UUID IDs, so convention-based detection would let them bypass it.
ALTER TABLE services
ADD COLUMN mens_menu INTEGER NOT NULL DEFAULT 0 CHECK (mens_menu IN (0, 1));

-- Keep these slug suffixes aligned with the existing women's menu IDs.
-- slot-times.ts uses endsWith for full-body/photo-addon absorption, so the same
-- multi-menu duration logic applies to these men's variants without another rule.
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
  -- Inserted INACTIVE on purpose. Deploy applies D1 migrations BEFORE publishing
  -- the new Worker, so an active row here would be
  -- bookable by the currently deployed Worker — which knows nothing about the
  -- men's booking window and would accept Monday / Thursday / before-13:00
  -- bookings until the new Worker takes over (or indefinitely, if the deploy step
  -- fails after the migration succeeded). A follow-up migration flips these to
  -- active once the enforcing Worker is serving production.
  0,
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

-- This is the existing men's VIO service; keep its ID, duration, and price.
UPDATE services
SET
  name = 'メンズ｜サンプル 01',
  mens_menu = 1,
  updated_at = CURRENT_TIMESTAMP
WHERE id = 'service_kyoto_hair_removal_vio_men_45';
