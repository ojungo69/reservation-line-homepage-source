ALTER TABLE services ADD COLUMN price_amount INTEGER
  CHECK (price_amount IS NULL OR (typeof(price_amount) = 'integer' AND price_amount BETWEEN 0 AND 1000000));
ALTER TABLE services ADD COLUMN combo_price_amount INTEGER
  CHECK (combo_price_amount IS NULL OR (typeof(combo_price_amount) = 'integer' AND combo_price_amount BETWEEN 0 AND 1000000));
ALTER TABLE services ADD COLUMN combo_with_prefix TEXT
  CHECK (combo_with_prefix IS NULL OR (typeof(combo_with_prefix) = 'text' AND length(combo_with_prefix) BETWEEN 1 AND 40));
