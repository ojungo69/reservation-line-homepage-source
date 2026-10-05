ALTER TABLE services ADD COLUMN price_label TEXT CHECK (price_label IS NULL OR length(price_label) <= 80);
