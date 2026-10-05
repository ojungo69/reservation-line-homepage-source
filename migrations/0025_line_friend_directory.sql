-- migrations/0025_line_friend_directory.sql
-- LINE友だち名簿＋プロフィールキャッシュ。未紐付け友だちは line_identities
-- (customer_id NOT NULL) に置けないため別テーブルで保持する。紐付け済み判定は
-- line_identities との (provider='line', channel_id, line_user_id) JOIN で導出し
-- ここには重複保存しない。channel_id は env.LINE_CHANNEL_ID（予約が
-- line_identities.channel_id に記録するログインチャネルID）を格納する。
CREATE TABLE IF NOT EXISTS line_friend_directory (
  channel_id          TEXT NOT NULL CHECK (length(channel_id) <= 128),
  line_user_id        TEXT NOT NULL CHECK (length(line_user_id) <= 128),
  display_name        TEXT CHECK (display_name IS NULL OR length(display_name) <= 120),
  picture_url         TEXT CHECK (picture_url IS NULL OR length(picture_url) <= 2048),
  profile_status      TEXT NOT NULL DEFAULT 'pending'
                        CHECK (profile_status IN ('pending', 'fetched', 'unavailable')),
  profile_fetched_at  TEXT,
  review_state        TEXT NOT NULL DEFAULT 'pending'
                        CHECK (review_state IN ('pending', 'ignored')),
  first_seen_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_synced_at      TEXT,
  PRIMARY KEY (channel_id, line_user_id)
);

CREATE INDEX IF NOT EXISTS idx_line_friend_directory_work
  ON line_friend_directory (channel_id, review_state, profile_status);
