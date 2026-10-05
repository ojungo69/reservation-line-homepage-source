PRAGMA foreign_keys = ON;

UPDATE services
SET
  name = rtrim(replace(replace(replace(name, ' 30分', ''), ' 45分', ''), ' 60分', '')),
  updated_at = CURRENT_TIMESTAMP
WHERE name LIKE '脱毛｜%'
  OR name LIKE 'フェイシャル｜%'
  OR name LIKE 'ネイル・フットケア｜%';
