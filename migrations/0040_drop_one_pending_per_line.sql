-- 全予約承認制への移行:
-- 公開Web予約は新規・既存を問わず常に pending_approval で作成されるため、
-- 「同一LINE identityのactiveな承認待ちは1件まで」の unique index を撤廃する。
-- 乱用防止は trg_reservations_web_cap (store_settings.max_active_reservations_per_customer、
-- 既定3件、confirmed + 未失効 pending を合算) が引き続き担う。
DROP INDEX IF EXISTS idx_reservations_one_pending_per_line;
